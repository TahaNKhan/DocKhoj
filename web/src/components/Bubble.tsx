// Bubble — user turn (right, accent fill) or assistant turn (left,
// gradient surface with accent left bar). Streams a streaming caret
// when `streaming` is true. Sources chips render when `sources` is
// provided. Follow-up pills render when `followups` is provided.
//
// Assistant bubbles render their text as sanitized markdown (p2-T21 /
// FR-33). User bubbles render plain text — we never trust the user's
// own input to be safe to inject as HTML.

import { renderMarkdown } from '../services/markdown';

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
  timestamp?: string;
  onSourceClick?: (source: Source) => void;
  onFollowupClick?: (followup: Followup) => void;
}

export function Bubble({
  role,
  text,
  streaming = false,
  sources = [],
  followups = [],
  timestamp = 'just now',
  onSourceClick,
  onFollowupClick,
}: Props) {
  const className = `bubble ${role}`;
  const whoLabel = role === 'user' ? 'You' : 'DocKhoj';

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
      {sources.length > 0 && (
        <div class="srcs">
          {sources.map((s) => (
            <span
              key={s.id}
              class="chip"
              onClick={() => onSourceClick?.(s)}
              role="button"
              tabIndex={0}
            >
              <span class="n">[{s.number}]</span> {s.fileName}{' '}
              {s.page && <span class="p">{s.page}</span>}
            </span>
          ))}
        </div>
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
