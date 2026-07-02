// ToolCallChip — compact representation of an agent tool invocation,
// rendered under an assistant bubble when `toolCalls` is present
// (p3-T09). Click expands to show full arguments + the matching
// tool result.
//
// This component is presentation-only — it owns no state for the
// expansion; expansion is local. A single ToolCallRecord is the
// unit (it carries the result inline).

import { useState } from 'preact/hooks';
import type { ToolCallRecord } from '../types';

interface Props {
  toolCall: ToolCallRecord;
}

function previewArgs(name: string, args: Record<string, unknown>): string {
  const compact = (k: string, max = 24): string => {
    const v = args[k];
    if (v === undefined || v === null) return '';
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    if (s.length <= max) return `${k}=${s}`;
    return `${k}=${s.slice(0, max - 1)}…`;
  };
  switch (name) {
    case 'get_neighbor_chunks':
      return `${compact('filePath')} ${compact('chunkIndex', 4)}${args.range !== undefined ? ` range=${args.range}` : ''}`.trim();
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

export function ToolCallChip({ toolCall }: Props) {
  const [expanded, setExpanded] = useState(false);
  const summary = previewArgs(toolCall.name, toolCall.arguments);

  return (
    <div class={`tool-chip call${expanded ? ' expanded' : ''}`}>
      <button
        class="tool-chip-head"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span class="tool-icon" aria-hidden="true">⚙</span>
        <span class="tool-name">{toolCall.name}</span>
        {summary && <span class="tool-summary">{summary}</span>}
        <span class="tool-iter">iter {toolCall.iteration + 1}</span>
        {toolCall.truncated && <span class="tool-truncated">truncated</span>}
      </button>
      {expanded && (
        <div class="tool-chip-body">
          <div class="tool-section">
            <div class="tool-section-label">Arguments</div>
            <pre class="tool-args">{JSON.stringify(toolCall.arguments, null, 2)}</pre>
          </div>
          <div class="tool-section">
            <div class="tool-section-label">Result</div>
            <pre class="tool-result">
              {JSON.stringify(toolCall.result, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
