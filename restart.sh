#!/bin/bash
set -e

# DocKhoj hot-iteration loop.
#
# Default (no args, or `hot`): rebuilds and recreates ONLY the app
# container — Ollama and Qdrant keep running. Ollama's image bakes in
# the embedding model on first build (see Dockerfile.ollama), so a full
# rebuild takes minutes; there's no reason to redo that on every
# frontend tweak.
#
# Pass `--full` for a clean rebuild (fresh clone, edited the Ollama
# Dockerfile, edited docker-compose.yml, or just want to start over).
# The full path tears everything down and rebuilds from scratch with
# `--no-cache`.
#
# Persistence: state lives under $DOCKHOJ_HOME (default ~/.dockhoj).
# `migrate_state` runs first on every invocation to lift the old
# ./qdrant_data/ + in-container SQLite into the new layout so users
# upgrading from a previous version don't lose their sessions.

DOCKHOJ_HOME="${DOCKHOJ_HOME:-$HOME/.dockhoj}"
export DOCKHOJ_HOME

mkdir -p "$DOCKHOJ_HOME/db" "$DOCKHOJ_HOME/qdrant" "$DOCKHOJ_HOME/documents"

# One-shot migration from the old layout. Each step is guarded so the
# script is safe to re-run: if the source is empty or the target
# already has data, the step is a no-op.
migrate_state() {
  # Uploaded files: ./documents/* → ~/.dockhoj/documents/. Same
  # copy-not-move pattern as Qdrant below: while the app container
  # could be holding an open fd on a recently-written file, the
  # user can review the duplicate and clean it up after the new
  # layout is verified.
  if [[ -d ./documents ]] \
     && [[ -n "$(ls -A ./documents 2>/dev/null || true)" ]] \
     && [[ -z "$(ls -A "$DOCKHOJ_HOME/documents" 2>/dev/null || true)" ]]; then
    echo "Migrating uploaded documents: ./documents/ → $DOCKHOJ_HOME/documents/"
    cp -a ./documents/. "$DOCKHOJ_HOME/documents/"
    echo "  Old directory preserved at ./documents/. Run"
    echo "  'rm -rf ./documents' after verifying the app is"
    echo "  reading from $DOCKHOJ_HOME/documents."
  fi

  # Qdrant: ./qdrant_data/* (old bind mount target) → ~/.dockhoj/qdrant/
  # Copy only — never delete ./qdrant_data/. While the qdrant
  # container is running its files are mmap-locked and `rm` from the
  # host hits "Permission denied". Leaving the source in place is a
  # harmless duplicate (~500 MB); the user can `rm -rf ./qdrant_data`
  # after verifying the migration worked and the qdrant container is
  # bound to the new path.
  if [[ -d ./qdrant_data ]] \
     && [[ -n "$(ls -A ./qdrant_data 2>/dev/null || true)" ]] \
     && [[ -z "$(ls -A "$DOCKHOJ_HOME/qdrant" 2>/dev/null || true)" ]]; then
    echo "Migrating Qdrant data: ./qdrant_data/ → $DOCKHOJ_HOME/qdrant/"
    cp -a ./qdrant_data/. "$DOCKHOJ_HOME/qdrant/"
    echo "  Old directory preserved at ./qdrant_data/. Run"
    echo "  'rm -rf ./qdrant_data' after verifying the qdrant container"
    echo "  is now bound to $DOCKHOJ_HOME/qdrant."
  fi

  # SQLite: docker cp from the running app container → ~/.dockhoj/db/.
  # Only meaningful if the app container is up (hot path); --full
  # tears it down so this step is skipped there. We checkpoint first
  # so we copy a single coherent conversations.db without dangling
  # WAL frames; better-sqlite3 in the image gives us that without
  # needing the sqlite3 CLI.
  if docker ps --format '{{.Names}}' | grep -q '^dockhoj-app$' \
     && [[ -z "$(ls -A "$DOCKHOJ_HOME/db" 2>/dev/null || true)" ]]; then
    echo "Migrating SQLite from running app container → $DOCKHOJ_HOME/db/"
    docker exec dockhoj-app node -e '
      const Database = require("better-sqlite3");
      const db = new Database("/app/data/conversations.db");
      db.pragma("wal_checkpoint(TRUNCATE)");
      db.close();
    ' 2>/dev/null || true
    docker cp dockhoj-app:/app/data/conversations.db "$DOCKHOJ_HOME/db/" 2>/dev/null || true
  fi
}

migrate_state

mode="${1:-hot}"

if [[ "$mode" == "--full" ]]; then
  echo "Full rebuild: tearing down all services..."
  docker compose down --remove-orphans

  echo "Rebuilding images (no cache)..."
  docker compose build --no-cache

  echo "Starting all services..."
  docker compose up -d
elif [[ "$mode" == "hot" ]]; then
  # If Ollama isn't running yet (fresh clone, or after a `--full`
  # teardown), bring it up first. This is the only step that can be
  # slow — the first run triggers the Ollama image build (which pulls
  # the embedding model).
  if ! docker ps --format '{{.Names}}' | grep -q '^dockhoj-ollama$'; then
    echo "Ollama not running — starting Ollama + Qdrant (first run builds the Ollama image)..."
    docker compose up -d ollama qdrant
  fi

  # Force-recreate Qdrant so its bind mount picks up the new
  # ${DOCKHOJ_HOME}/qdrant path. The container restart is cheap
  # (a few seconds, no image rebuild) and avoids the situation where
  # Qdrant is still reading from the old ./qdrant_data/ while new
  # writes go to the new path — that would silently split the
  # collection across two directories.
  echo "Recreating Qdrant container (so it picks up the new bind mount)..."
  docker compose up -d --no-deps --force-recreate qdrant

  echo "Rebuilding app image (Ollama stays up)..."
  docker compose build app

  echo "Recreating app container..."
  docker compose up -d --no-deps --force-recreate app
else
  echo "Unknown mode: $mode"
  echo "Usage: $0 [hot|--full]"
  exit 1
fi

echo "Waiting for app to be healthy..."
sleep 2

# The container's HEALTHCHECK polls /api/health every 5s; give it
# up to ~40s headroom in case npm install has to fetch something.
for i in {1..20}; do
  if curl -s http://localhost:3001/api/health > /dev/null 2>&1; then
    echo "App is healthy!"
    exit 0
  fi
  echo "Waiting... ($i/20)"
  sleep 2
done

echo "App failed to become healthy. Check logs:"
docker logs dockhoj-app --tail 20
exit 1