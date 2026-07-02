# DocKhoj — Project Notes

This file supplements the global `~/.claude/CLAUDE.md` with DocKhoj-specific guidance. Read the global one first; the project file only adds what's DocKhoj-specific.

## End-to-end testing protocol — `./restart.sh` + curl

DocKhoj is a Docker Compose stack (Ollama + Qdrant + the Fastify app). The fastest way to validate any change is to spin the real stack up and exercise it with `curl` — no mocks, no test harnesses pretending to be OpenAI or Qdrant. We treat the running container as the source of truth.

**The loop, run after every task:**

1. **Build + boot.** From the project root:

   ```bash
   ./restart.sh
   ```

   This tears down any existing `dockhoj-*` containers, rebuilds the app + ollama images with `--no-cache`, brings all three services up, and waits up to ~20s for `curl /api/health` to return `{"status":"ok",...}`. The first build after a fresh clone takes a few minutes (Ollama pulls `nomic-embed-text`); subsequent builds are seconds.

2. **Sanity-check the API surface.** Every API is under `/api/*`. The page routes (`/chat`, `/upload`) are served by the SPA from `web/dist/`:

   ```bash
   # Health
   curl -s http://localhost:3001/api/health
   #  -> {"status":"ok","ollama":true}

   # Live chunk count + Ollama reachability (for the TopBar)
   curl -s http://localhost:3001/api/status
   #  -> {"chunks":298,"ollamaAvailable":true}

   # SPA pages
   curl -sI http://localhost:3001/chat    # 200 text/html
   curl -sI http://localhost:3001/upload  # 200 text/html

   # /api/* 404s return JSON, never HTML
   curl -s http://localhost:3001/api/does-not-exist
   #  -> {"error":"Not found"}
   ```

3. **Exercise the API surface you're changing.** Some useful patterns:

   ```bash
   # Create a session
   SID=$(curl -s -X POST http://localhost:3001/api/sessions \
     | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")

   # Stream a chat (SSE)
   timeout 15 curl -s -N -X POST http://localhost:3001/api/chat/stream \
     -H 'Content-Type: application/json' \
     -d "{\"q\":\"hello\",\"sessionId\":\"$SID\"}"
   #  -> event: meta / sources / token*N / done / title

   # Upload (multipart)
   curl -s -X POST http://localhost:3001/api/upload \
     -F "file=@./documents/some.md"

   # Inspect a session's messages
   curl -s http://localhost:3001/api/sessions/$SID/messages | python3 -m json.tool
   ```

4. **Inspect container logs when something looks wrong.** Most "it works in tests but not in the container" bugs surface in the logs:

   ```bash
   docker logs dockhoj-app --tail 100
   ```

5. **Clean up before committing.** Stopping the stack is fine to leave running (it'll restart on the next `./restart.sh`), but prune dangling images if you've been experimenting:

   ```bash
   docker image prune -f
   ```

**What this protocol catches that unit tests miss:**

- Server-side build / TS errors that only surface under `tsc` (the container rebuilds on every `./restart.sh`).
- `module.exports` vs `import.meta.url` path-resolution bugs (the global CLAUDE.md caught one in T38 — `./app/dist/..` paths don't work the way you'd expect in a Docker build context).
- Real OpenAI / Ollama / Qdrant behavior, including the `<think>` chain-of-thought the streaming model emits by default (T33 added a stateful filter to suppress it).
- DB schema migrations actually applying cleanly on a fresh volume (T26).
- The Dockerfile `HEALTHCHECK` path matching the actual `/api/health` route (T19/T52).

**What we deliberately do NOT do here:**

- Mock OpenAI or Qdrant in tests — see §2.0 of the global CLAUDE.md. Real services, real responses.
- Run vitest as the primary signal — see §2.1 below.

## Vitest — secondary, for logic that's awkward to hit via curl

Vitest still runs the SQLite migration runner, the ConversationStore, the title generator, the SSE orchestrator, and route handlers via `fastify.inject`. We keep these because:

- The migration runner's idempotency and the SQL file ordering is awkward to exercise through curl (would require `docker volume rm` + container restart).
- The ConversationStore's title-source overwrite rules are pure data-shape logic.
- The stream-chat orchestrator's error / abort behavior is faster to assert in a test than by killing a real curl mid-stream.

Use `npm test -- --run` (or `npx vitest run tests/<file>.test.ts` for one file). Per the global CLAUDE.md §3, all tests must pass before committing.

## Spec workflow reminder

This project follows the spec-workflow convention documented in §7 of the global CLAUDE.md:

- Phase docs live under `docs/specs/phase-NN-name/`.
- Phase 03 spec is the source of truth for in-flight work: `docs/specs/phase-03-document-deletion-and-agentic-rag/`.
- `TASKS.md` at the project root is an **index** of per-phase task files; each phase owns its own `TASKS.md` inside its spec folder. T-numbers are scoped to the phase folder.
- Before implementing a non-trivial change, update `design.md` first, then code (per §3 of the global CLAUDE.md).

## Git workflow reminder

The global CLAUDE.md §3 / §9 govern commits:

- One task = one commit (typically). If a commit mixes concerns, expect a review note.
- Don't bypass hooks (`./restart.sh` is the closest thing we have to a pre-commit hook here — it IS the integration test).
- Branch protection on `main` flags "Changes must be made through a pull request" — that's the GitHub-side setting, not a project rule. Pushes still land; the user can decide later whether to convert to PRs.