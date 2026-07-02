// ToolUseLine — single, minimal "Tool use" line in the assistant
// bubble (p3-T16). Replaces the per-call ToolCallChip /
// ToolResultChip rows with one collapsed-by-default accordion that
// lists every tool the agent loop ran for the current turn.
//
// Collapsed: a small chip "🔧 Tool use · N calls · M iterations" with
// a chevron — sits inline with the bubble text, doesn't break the
// bubble's visual rhythm.
// Expanded: a flat list of every tool call (tool name + args
// preview + result summary); no nested accordions.
//
// The component is presentation-only. It owns no state for the
// assistant text or the bubble; the Bubble renders it when
// `toolCalls.length > 0`.

import { useState } from 'preact/hooks';
import type { ToolCallRecord } from '../types';

interface Props {
  toolCalls: ToolCallRecord[];
}

const CHEVRON_DOWN = '▾'; // ▾
const CHEVRON_UP = '▴';   // ▴

// Distinctive icon glyph for the line. The wrench emoji renders on
// every modern OS without needing a custom font.
const ICON = '\u{1F527}'; // 🔧

function previewArgs(name: string, args: Record<string, unknown>): string {
  // One-line summary of the call's arguments. Designed to fit on a
  // single row in the expanded list — long values are truncated with
  // an ellipsis.
  const compact = (k: string, max = 24): string => {
    const v = args[k];
    if (v === undefined || v === null) return '';
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    if (s.length <= max) return `${k}=${s}`;
    return `${k}=${s.slice(0, max - 1)}…`;
  };
  switch (name) {
    case 'get_neighbor_chunks':
      return `${compact('filePath')} ${compact('chunkIndex', 4)}${args.range !== undefined ? ` range=${String(args.range)}` : ''}`.trim();
    case 'get_section_chunks': {
      const hp = Array.isArray(args.headingPath) ? args.headingPath.join(' / ') : '';
      return `${compact('filePath')} ${hp}`.trim();
    }
    case 'get_chunk':
      return compact('chunkId');
    case 'get_document':
      return compact('filePath');
    default:
      return Object.keys(args)
        .slice(0, 2)
        .map((k) => compact(k))
        .join(' ');
  }
}

function summarizeResult(name: string, result: unknown, truncated: boolean): string {
  // One-line summary for the right side of each row in the expanded
  // list. Mirrors ToolResultChip.summarizeResult from p3-T09 (now
  // removed in p3-T16).
  const r = result as { kind?: string; chunks?: unknown[]; document?: unknown; message?: string } | null;
  if (!r || typeof r !== 'object') return 'no result';
  if (r.kind === 'chunks') {
    const n = Array.isArray(r.chunks) ? r.chunks.length : 0;
    return `${n} chunk${n === 1 ? '' : 's'}`;
  }
  if (r.kind === 'document') {
    return r.document ? 'metadata' : 'no document';
  }
  if (r.kind === 'error') {
    return r.message ? `error: ${r.message}` : 'error';
  }
  return truncated ? `${name} (truncated)` : name;
}

function uniqueIterationCount(calls: ToolCallRecord[]): number {
  // number of distinct iterations the agent loop ran. Show this as
  // "N iterations" only if the agent loop made at least 2 iterations
  // — a single tool call with no tool fall-through is just "1 call".
  const iters = new Set<number>();
  for (const c of calls) iters.add(c.iteration);
  return iters.size;
}

export function ToolUseLine({ toolCalls }: Props) {
  const [expanded, setExpanded] = useState(false);

  if (toolCalls.length === 0) return null;

  // Collapse "1 call" + "1 iteration" down to just "1 call" — the
  // iteration count only adds info when the agent loop looped.
  const iterations = uniqueIterationCount(toolCalls);
  const iterLabel = iterations > 1 ? ` · ${iterations} iterations` : '';

  return (
    <div class={`tool-use-line${expanded ? ' expanded' : ''}`}>
      <button
        class="tool-use-head"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <span class="tool-use-icon" aria-hidden="true">{ICON}</span>
        <span class="tool-use-label">Tool use</span>
        <span class="tool-use-count">
          {' · '}
          {toolCalls.length} call{toolCalls.length === 1 ? '' : 's'}{iterLabel}
        </span>
        <span class="tool-use-caret" aria-hidden="true">
          {expanded ? CHEVRON_UP : CHEVRON_DOWN}
        </span>
      </button>
      {expanded && (
        <ul class="tool-use-list" role="list">
          {toolCalls.map((tc, i) => (
            <li key={i} class="tool-use-row">
              <span class="tool-use-row-name">{tc.name}</span>
              <span class="tool-use-row-args">
                {previewArgs(tc.name, tc.arguments) || '—'}
              </span>
              <span class="tool-use-row-result">
                {' → '}
                {summarizeResult(tc.name, tc.result, tc.truncated)}
              </span>
              {tc.truncated && (
                <span class="tool-use-truncated" aria-label="result was truncated">truncated</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}