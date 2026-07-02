// Stateful filter that strips <think>…</think> blocks from a stream
// of LLM delta text. Lives in its own module so the route handler
// (chat-stream.ts) can keep its top-level surface small and so the
// tag-handling logic is unit-testable without standing up Fastify.
//
// The original filter (Phase 02 / p2-T12) only stripped text
// *between* a matched pair of tags. That breaks when the LLM emits
// a stray </think> with no opener — the literal tag chars then
// leak into the streamed text, e.g. "cle IV.</think>visions." shows
// up in the chat bubble. The fixes here:
//
//   1. When `inside === false` and the buffer contains a stray
//      </think>, strip the tag chars and emit whatever precedes
//      them. Loop so consecutive stray closers in the same push
//      are all stripped.
//   2. Hold back any `<` in the buffer (not just the last 8 chars)
//      so a partial tag — opener or closer — that straddles a chunk
//      boundary doesn't leak.
//   3. flush() also strips any stray </think> that ends up in the
//      buffer at stream-end.
//   4. The whole pass is a loop, so a single push containing both
//      an opener and a closer (or a complete think block) is
//      processed atomically rather than split across pushes.

const OPEN_TAG = '<think>';
const CLOSE_TAG = '</think>';

export interface ThinkFilter {
  /**
   * Push a chunk of text through the filter. Returns any visible
   * portion that should be sent to the client (text outside think
   * blocks). Returns null if nothing new is visible yet.
   */
  push(text: string): string | null;
  /**
   * Flush whatever's left in the buffer at stream-end. Returns the
   * remaining visible text, or null if inside a still-open think
   * block or nothing's left.
   */
  flush(): string | null;
}

export function createThinkFilter(): ThinkFilter {
  let inside = false;
  let buf = '';

  return {
    push(text: string): string | null {
      buf += text;
      let out = '';

      // Loop so a single push containing multiple tag transitions
      // (e.g. `<think>…</think>more`) is processed in one pass.
      // Bound the loop to buf.length to prevent infinite cycles if
      // a future branch forgets to advance.
      for (let safety = 0; safety <= buf.length; safety++) {
        // Opener — enter think mode, emit anything before the tag.
        if (!inside && buf.includes(OPEN_TAG)) {
          const idx = buf.indexOf(OPEN_TAG);
          out += buf.slice(0, idx);
          buf = buf.slice(idx + OPEN_TAG.length);
          inside = true;
          continue;
        }

        // Legitimate closer — exit think mode, drop the close tag.
        if (inside && buf.includes(CLOSE_TAG)) {
          const idx = buf.indexOf(CLOSE_TAG);
          buf = buf.slice(idx + CLOSE_TAG.length);
          inside = false;
          continue;
        }

        // Stray closing tag (no opener seen) — strip the tag chars
        // so the literal text doesn't leak into the streamed text.
        // Common with the agent loop's intermediate LLM calls,
        // which sometimes emit a bare </think>.
        if (!inside && buf.includes(CLOSE_TAG)) {
          const idx = buf.indexOf(CLOSE_TAG);
          out += buf.slice(0, idx);
          buf = buf.slice(idx + CLOSE_TAG.length);
          continue;
        }

        break;
      }

      // Inside a think block — withhold everything.
      if (inside) return out || null;

      // Outside, no complete tag visible yet. Hold back from the
      // first '<' (not just the last 8 chars): any '<' could be the
      // start of a partial opener or closer straddling the chunk
      // boundary. Appending to `out` preserves any tag-stripping
      // text we already accumulated above.
      const angleIdx = buf.indexOf('<');
      const split = angleIdx === -1 ? buf.length : angleIdx;
      out += buf.slice(0, split);
      buf = buf.slice(split);
      return out || null;
    },

    flush(): string | null {
      if (inside || !buf) return null;
      // Strip any stray full closing tag — without this, a stray
      // </think> sitting in the buffer at stream-end leaks out.
      let out = buf.includes(CLOSE_TAG) ? buf.replace(/<\/think>/g, '') : buf;
      // If a partial tag is still in the buffer (a `<` that could
      // grow into an opener or closer on the next push), withhold
      // it. A `signal.aborted` cut usually lands here; the partial
      // is dropped rather than leaked as literal text.
      if (out.includes('<')) {
        out = out.slice(0, out.indexOf('<'));
      }
      return out || null;
    },
  };
}