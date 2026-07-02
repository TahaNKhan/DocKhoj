// ToolResultChip — compact representation of a tool RESULT, rendered
// next to the matching ToolCallChip when both are present (p3-T09).
//
// Most chips render the result body inline (with ToolCallChip as the
// parent). Standalone usage (when only the result exists) is rare
// and unsupported for now. Kept as its own component so the wire
// shape can be reused in tool-call-record read paths
// (re-hydration from the persisted assistant message).

import { useState } from 'preact/hooks';
import type { ToolResultRecord } from '../types';

interface Props {
  name: string;
  result: ToolResultRecord['result'];
  truncated: boolean;
  iteration: number;
  // Optional body preview cap (chars) before the "see full" toggle.
  previewChars?: number;
}

function summarizeResult(name: string, result: unknown): string {
  if (!result || typeof result !== 'object') return 'no result';
  const r = result as { kind?: string; chunks?: unknown[]; document?: unknown };
  if (r.kind === 'chunks') {
    const n = Array.isArray(r.chunks) ? r.chunks.length : 0;
    return `${n} chunk${n === 1 ? '' : 's'}`;
  }
  if (r.kind === 'document') {
    return r.document ? 'metadata' : 'no document';
  }
  if (r.kind === 'error') {
    const err = result as { code?: string; message?: string };
    return err.message ? `error: ${err.message}` : 'error';
  }
  return name;
}

function truncateBody(body: string, cap: number): string {
  if (body.length <= cap) return body;
  return body.slice(0, cap) + '\n... (truncated for preview — expand to see all)';
}

export function ToolResultChip({
  name,
  result,
  truncated,
  iteration,
  previewChars = 500,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const summary = summarizeResult(name, result);
  const body = JSON.stringify(result, null, 2);
  const preview = truncated ? truncateBody(body, previewChars) : body;

  return (
    <div class={`tool-chip result${expanded ? ' expanded' : ''}`}>
      <button
        class="tool-chip-head"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span class="tool-icon" aria-hidden="true">↩</span>
        <span class="tool-name">{name}</span>
        <span class="tool-summary">{summary}</span>
        <span class="tool-iter">iter {iteration + 1}</span>
        {truncated && <span class="tool-truncated">truncated</span>}
      </button>
      {expanded && (
        <div class="tool-chip-body">
          <pre class="tool-result">
            {expanded ? body : preview}
          </pre>
        </div>
      )}
    </div>
  );
}
