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

  echo "Rebuilding app image (Ollama + Qdrant stay up)..."
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