// Bubble — user turn (right, accent fill) or assistant turn (left,
// gradient surface with accent left bar). Streams a streaming caret
// when `streaming` is true. Sources chips render when `sources` is
// provided. Follow-up pills render when `followups` is provided.
//
// Assistant bubbles render their text as sanitized markdown (p2-T21 /
// FR-33). User bubbles render plain text — we never trust the user's
// own input to be safe to inject as HTML.
//
// p3-T16 — agent tool use renders as a single collapsed "Tool use"
// line (ToolUseLine) below the message text. Replaces the per-call
// chips from p3-T09 (ToolCallChip + ToolResultChip — deleted with
// this commit; the data shape is unchanged, only the rendering is
// different).
//
// p3-T18 — sources are de-duped by file: a question that pulls 15
// chunks from notes.md now shows ONE chip labeled
// `[1] notes.md · 15 chunks` instead of 15 identical chips. Click
// the chip → drawer lists every chunk for that file with
// page/score/heading-path; selecting a chunk swaps the rendered
// markdown below.

import { renderMarkdown } from '../services/markdown';
import { ToolUseLine } from './ToolUseLine';
import type { ToolCallRecord } from '../types';

// Source — what a chat bubble's [1] / [2] chip carries. The Bubble
// renders just enough to identify the chunk (number, fileName, page);
// the full chunk text + heading path + score live here so the
// SourceDrawer (p2-T16) can show them when a chip is clicked.
export interface Source {
  id: string;
  number: number;
  fileName: string;
  filePath: string;
  page?: string; // formatted: "p.3"
  pageNumber?: number;
  headingPath?: string[];
  chunk: string;
  score: number;
}

// DocSourceGroup — a fileName + filePath + all the chunks we cited
// from that file. The Bubble groups `Source[]` by file (keyed on
// filePath, falling back to fileName) and renders one chip per
// group; clicking the chip hands the whole group to the
// DocSourceDrawer.
export interface DocSourceGroup {
  fileName: string;
  filePath: string;
  chunks: Source[];
}

export interface Followup {
  id: string;
  text: string;
}

interface Props {
  role: 'user' | 'assistant';
  text: string;
  streaming?: boolean;
  sources?: Source[];
  followups?: Followup[];
  toolCalls?: ToolCallRecord[];
  timestamp?: string;
  // onSourceClick is kept for backward compatibility (the legacy
  // single-source drawer path). New callers should use
  // onDocSourceClick with a DocSourceGroup.
  onSourceClick?: (source: Source) => void;
  onDocSourceClick?: (group: DocSourceGroup) => void;
  onFollowupClick?: (followup: Followup) => void;
}

// Group sources by their on-disk filePath (with fileName as a
// fallback for chunks missing filePath). Returns groups in the
// order they first appear in `sources`, so the bubble's doc
// numbering follows the assistant's citation order.
function groupSourcesByFile(sources: Source[]): DocSourceGroup[] {
  const out: DocSourceGroup[] = [];
  const indexByKey = new Map<string, number>();
  for (const s of sources) {
    const key = s.filePath || s.fileName;
    let idx = indexByKey.get(key);
    if (idx === undefined) {
      idx = out.length;
      indexByKey.set(key, idx);
      out.push({ fileName: s.fileName, filePath: s.filePath, chunks: [] });
    }
    out[idx]!.chunks.push(s);
  }
  return out;
}

export function Bubble({
  role,
  text,
  streaming = false,
  sources = [],
  followups = [],
  toolCalls = [],
  timestamp = 'just now',
  onSourceClick,
  onDocSourceClick,
  onFollowupClick,
}: Props) {
  const className = `bubble ${role}`;
  const whoLabel = role === 'user' ? 'You' : 'DocKhoj';
  const groupedSources = groupSourcesByFile(sources);

  return (
    <div class={className}>
      <div class="who">
        <b>{whoLabel}</b>
        <span class="dot" />
        {timestamp}
      </div>
      {role === 'assistant' ? (
        <div class="text">
          {/* renderMarkdown runs marked.parse then DOMPurify.sanitize
              (FR-33 XSS protection). Streaming re-renders on each
              token tick; sanitization is cheap enough to do per chunk. */}
          <div dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
          {streaming && <span class="caret" />}
        </div>
      ) : (
        <div class="text">
          {text}
          {streaming && <span class="caret" />}
        </div>
      )}
      {groupedSources.length > 0 && (
        <div class="srcs">
          {groupedSources.map((g, i) => (
            <span
              key={g.filePath || g.fileName}
              class="chip doc-chip"
              role="button"
              tabIndex={0}
              onClick={() => {
                if (onDocSourceClick) {
                  onDocSourceClick(g);
                } else if (onSourceClick && g.chunks[0]) {
                  // Legacy fallback: open the single-chunk drawer
                  // with the first chunk so existing callers still
                  // get a working click target.
                  onSourceClick(g.chunks[0]);
                }
              }}
            >
              <span class="n">[{i + 1}]</span> {g.fileName}{' '}
              <span class="count">
                {' · '}
                {g.chunks.length} chunk{g.chunks.length === 1 ? '' : 's'}
              </span>
            </span>
          ))}
        </div>
      )}
      {role === 'assistant' && toolCalls.length > 0 && (
        <ToolUseLine toolCalls={toolCalls} />
      )}
      {role === 'assistant' && followups.length > 0 && (
        <div class="followups">
          {followups.map((f) => (
            <span
              key={f.id}
              class="followup"
              onClick={() => onFollowupClick?.(f)}
              role="button"
              tabIndex={0}
            >
              {f.text}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}