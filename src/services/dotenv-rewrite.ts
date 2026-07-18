/**
 * Pure `.env` file rewriter. Hand-curated `.env` files don't need a dotenv
 * parser — we just append new keys and replace existing ones in place,
 * preserving every other line byte-for-byte (comments, blanks, ordering).
 *
 * Used by `scripts/setup-oidc.ts` to write OIDC keys into a user's `.env`
 * without disturbing anything else. See phase-06 design §"Tech stack".
 */

/**
 * Rewrite `.env` file content with the given key updates.
 *
 * - Existing keys (matched by exact `KEY=` prefix, no substring/prefix match
 *   on the key itself — `OIDC_CLIENT` will not match `OIDC_CLIENT_ID=`) are
 *   replaced in place, preserving their original line position.
 * - New keys are appended, one per line, in `Object` insertion order.
 * - Comments (`#...`), blank lines, and unrelated `KEY=value` lines are
 *   preserved verbatim.
 * - The result ends with exactly one trailing `\n`.
 *
 * CRLF inputs are normalized to LF (noted, acceptable — `.env` is hand-edited
 * and git's autocrlf would do the same on commit).
 */
export function rewriteEnvFile(
  content: string,
  updates: Record<string, string>,
): string {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const remaining = new Map<string, string>(Object.entries(updates));

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    for (const [key, value] of remaining) {
      // Exact key match: line starts with `KEY=` (not `KEY` as a prefix of a
      // longer key name like `OIDC_CLIENT` vs `OIDC_CLIENT_ID`).
      if (line.startsWith(`${key}=`)) {
        lines[i] = `${key}=${value}`;
        remaining.delete(key);
        break;
      }
    }
  }

  // Drop a trailing empty string produced by `split` when content ends with
  // `\n`; appended keys go below, and we normalize to one trailing newline.
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  for (const [key, value] of remaining) {
    lines.push(`${key}=${value}`);
  }

  return `${lines.join('\n')}\n`;
}
