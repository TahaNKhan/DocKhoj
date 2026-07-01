// Bubble — user turn (right, accent fill) or assistant turn (left,
// gradient surface with accent left bar). Streams a streaming caret
// when `streaming` is true. Sources chips render when `sources` is
// provided. Follow-up pills render when `followups` is provided.

export interface Source {
  id: string;
  number: number;
  fileName: string;
  page?: string;
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
      <div class="text">
        {text}
        {streaming && <span class="caret" />}
      </div>
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
