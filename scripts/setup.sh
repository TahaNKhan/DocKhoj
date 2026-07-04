#!/usr/bin/env bash
# DocKhoj one-shot installer.
#
# Two modes:
#   1. From a clone:           ./scripts/setup.sh          (idempotent — re-runs are safe)
#   2. From anywhere via curl: curl -sSL .../setup.sh | bash
#                               ↑ no clone? Clones ~/dockhoj for you, then continues.
#
# What it does:
#   - Checks for Docker (compose v2).
#   - Writes .env from .env.example if absent (idempotent).
#   - Prompts for OPENAI_API_KEY if not set in the environment or .env.
#   - Runs ./restart.sh (full first time; cheap rebuild on subsequent runs).
#   - Waits for /api/health and prints a friendly "what to do next".
#
# Re-running is the right way to "rebuild the app" after a code change:
# the script detects an existing install and skips the setup steps.

set -euo pipefail

# ── ANSI helpers (skip if not a TTY to keep piped output clean) ───────────────
if [[ -t 1 ]]; then
  BOLD=$'\e[1m'; DIM=$'\e[2m'; CYAN=$'\e[36m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; RED=$'\e[31m'; RESET=$'\e[0m'
else
  BOLD=''; DIM=''; CYAN=''; GREEN=''; YELLOW=''; RED=''; RESET=''
fi
say()  { printf '%s\n' "$*" >&2; }
info() { say "${CYAN}▸${RESET} $*"; }
ok()   { say "${GREEN}✓${RESET} $*"; }
warn() { say "${YELLOW}!${RESET} $*"; }
die()  { say "${RED}✗${RESET} $*" >&2; exit 1; }

# ── Detect repo root ─────────────────────────────────────────────────────────
in_repo() {
  [[ -f "./docker-compose.yml" && -f "./package.json" && -d "./scripts" ]]
}

if ! in_repo; then
  info "Not inside a DocKhoj clone — cloning into ~/dockhoj"
  DEST="${DOCKHOJ_INSTALL_DIR:-$HOME/dockhoj}"
  if [[ -d "$DEST" ]]; then
    info "Reusing existing $DEST"
  else
    command -v git >/dev/null 2>&1 || die "git is required (install git or clone the repo manually first)"
    git clone --depth 1 https://github.com/TahaNKhan/DocKhoj.git "$DEST"
  fi
  cd "$DEST"
fi

REPO_ROOT="$(pwd)"
say
say "${BOLD}DocKhoj setup${RESET} — ${DIM}$REPO_ROOT${RESET}"
say

# ── Prereqs ──────────────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "Docker is not installed. Get it from https://docs.docker.com/engine/install/"
docker info >/dev/null 2>&1 || die "Docker daemon is not running (or you lack permission). Start the daemon, or add yourself to the docker group."
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required. The 'docker compose' (no hyphen) command must work — see https://docs.docker.com/compose/."

ok "Docker is installed and the daemon is reachable"

# ── .env ─────────────────────────────────────────────────────────────────────
if [[ ! -f .env ]]; then
  info "Creating .env from .env.example"
  cp .env.example .env
  chmod 600 .env
  ok ".env written"
else
  ok ".env already present (leaving it alone)"
fi

# Resolve OPENAI_API_KEY from one of: env / .env / prompt.
read_env_var() {
  local key="$1"
  if [[ -f .env ]]; then
    # Tolerate spaces around the = and ignore comment lines.
    awk -F= -v key="$key" '
      $0 ~ "^[[:space:]]*#" { next }
      $1 == key { sub(/^[[:space:]]*/, "", $2); print; exit }
    ' .env
  fi
}

current_key="${OPENAI_API_KEY:-}"
if [[ -z "$current_key" || "$current_key" == "your_api_key_here" ]]; then
  current_key="$(read_env_var OPENAI_API_KEY || true)"
fi

if [[ -z "$current_key" || "$current_key" == "your_api_key_here" ]]; then
  if [[ -t 0 ]]; then
    say
    say "${BOLD}OPENAI_API_KEY${RESET} is not set. DocKhoj uses any OpenAI-compatible API for chat."
    say "${DIM}(OpenAI, Anthropic-via-gateway, MiniMax, or anything that speaks the /v1/chat/completions shape.)${RESET}"
    say
    printf '%s' "Paste your key (input is hidden if possible): "
    if [[ -r /dev/tty ]]; then
      read -rs OPENAI_API_KEY < /dev/tty || OPENAI_API_KEY=""
    else
      read -rs OPENAI_API_KEY
    fi
    say
  else
    die "OPENAI_API_KEY is not set and there is no TTY for prompting. Re-run with the env var set, e.g.:
         OPENAI_API_KEY=sk-... bash -c \"\$(curl -sSL .../setup.sh)\""
  fi
fi

if [[ -z "${OPENAI_API_KEY:-}" || "$OPENAI_API_KEY" == "your_api_key_here" ]]; then
  die "OPENAI_API_KEY is required to start. Aborting before touching Docker."
fi

ok "OPENAI_API_KEY is set"
export OPENAI_API_KEY

# Persist into .env so docker compose picks it up and so future runs don't re-prompt.
if [[ -f .env ]]; then
  if grep -qE '^[[:space:]]*OPENAI_API_KEY[[:space:]]*=' .env; then
    # Replace the line in place; keep everything else.
    awk -v key=OPENAI_API_KEY -v val="$OPENAI_API_KEY" '
      BEGIN { FS="="; replaced=0 }
      $0 ~ "^[[:space:]]*#" { print; next }
      $1 == key { print key "=" val; replaced=1; next }
      { print }
      END { if (!replaced) print key "=" val }
    ' .env > .env.tmp && mv .env.tmp .env
    chmod 600 .env
  else
    printf 'OPENAI_API_KEY=%s\n' "$OPENAI_API_KEY" >> .env
    chmod 600 .env
  fi
fi

# ── Boot ─────────────────────────────────────────────────────────────────────
say
info "Starting the stack (first run builds the Ollama image — pulls the embedding model)"
say

# Pipe-friendly exec. Pass any flags through (e.g. `--full` for a clean rebuild).
./restart.sh "$@"

# ── Verify + handoff ────────────────────────────────────────────────────────
say
say "${GREEN}${BOLD}App is healthy.${RESET}"

# Figure out what hostname to tell the user.
HOST_HINT="http://localhost:3001"
if [[ -n "${DOCKHOJ_HOST:-}" ]]; then
  HOST_HINT="http://${DOCKHOJ_HOST}:${PORT:-3001}"
fi

say "${BOLD}Next steps${RESET}:"
say "  1. Open ${CYAN}${HOST_HINT}/register${RESET} and create the first user"
say "     (that account becomes the admin; subsequent users need an invite)."
say "  2. Log in at ${CYAN}${HOST_HINT}/login${RESET}."
say "  3. Upload some docs at ${CYAN}${HOST_HINT}/upload${RESET}, then ask questions at ${CYAN}${HOST_HINT}/chat${RESET}."
say
say "${DIM}Re-run this script any time you want to rebuild after a code change."
say "State lives in \${DOCKHOJ_HOME:-$HOME/.dockhoj} — wipe that directory for a clean slate.${RESET}"
