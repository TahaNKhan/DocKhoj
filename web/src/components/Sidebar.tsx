import { useState } from 'preact/hooks';
import type { Conversation } from '../services/sessions';
import { getPinnedIds, togglePinnedId } from '../services/sessions';
import { AnimatedTitle } from './AnimatedTitle';

// Sidebar — Sessions + Pinned section + footer indicator. Pinned
// sessions are stored in localStorage and displayed in a separate
// section above the unpinned list.

interface Props {
  sessions: Conversation[];
  activeId: string | null;
  open: boolean;
  onClose: () => void;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename?: (id: string, currentTitle: string) => void;
  onDelete?: (id: string) => void;
}

export function Sidebar({ sessions, activeId, open, onClose, onSelect, onCreate, onRename, onDelete }: Props) {
  const [pinnedIds, setPinnedIds] = useState<string[]>(getPinnedIds);

  const pinned = sessions.filter((s) => pinnedIds.includes(s.id));
  const unpinned = sessions.filter((s) => !pinnedIds.includes(s.id));

  function handleTogglePin(id: string) {
    const nowPinned = togglePinnedId(id);
    setPinnedIds(getPinnedIds());
    // If the session was just unpinned and it's the active one, we
    // still keep it selected — the user just unpinned it, they didn't
    // navigate away.
    return nowPinned;
  }

  return (
    <aside id="sidebar" class={`side${open ? ' open' : ''}`}>
      <div class="side-brand">
        <span class="brand-mark" />
        <span class="brand-name">
          DocKhoj<i>.</i>
        </span>
      </div>

      {pinned.length > 0 && (
        <div>
          <h4>Pinned</h4>
          {pinned.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              active={s.id === activeId}
              pinned={true}
              onSelect={onSelect}
              onRename={onRename}
              onDelete={onDelete}
              onTogglePin={handleTogglePin}
            />
          ))}
        </div>
      )}

      <div>
        <h4>
          Sessions{' '}
          <i
            onClick={onCreate}
            role="button"
            aria-label="New session"
            title="New session"
          >
            +
          </i>
        </h4>
        {unpinned.length === 0 && sessions.length === 0 && (
          <div class="session" style={{ cursor: 'default' }}>
            <div class="t" style={{ color: 'var(--muted)' }}>
              No sessions yet
            </div>
            <div class="s">click + to start</div>
          </div>
        )}
        {unpinned.map((s) => (
          <SessionRow
            key={s.id}
            session={s}
            active={s.id === activeId}
            pinned={false}
            onSelect={onSelect}
            onRename={onRename}
            onDelete={onDelete}
            onTogglePin={handleTogglePin}
          />
        ))}
        {sessions.length > 0 && unpinned.length === 0 && (
          <div class="session" style={{ cursor: 'default' }}>
            <div class="t" style={{ color: 'var(--muted)' }}>
              all sessions pinned
            </div>
            <div class="s">unpin one to see it here</div>
          </div>
        )}
      </div>

      <div class="side-foot">
        <span>
          embed: <span class="k">nomic-embed-text · 768d</span>
        </span>
      </div>
    </aside>
  );
}

interface RowProps {
  session: Conversation;
  active: boolean;
  pinned: boolean;
  onSelect: (id: string) => void;
  onRename?: (id: string, currentTitle: string) => void;
  onDelete?: (id: string) => void;
  onTogglePin: (id: string) => boolean;
}

function SessionRow({ session, active, pinned, onSelect, onRename, onDelete, onTogglePin }: RowProps) {
  const rel = relativeTime(session.updatedAt);
  const sources = session.messageCount > 0 ? `${session.messageCount} msgs` : 'empty';

  // The × button is the discoverable delete surface; right-click is
  // still wired for desktop power-users. The button sits in the
  // top-right of the row, hidden on hover for desktop and always
  // visible on touch (where hover doesn't exist). The pin button
  // sits in the bottom-right of the row.
  return (
    <div
      class={`session${active ? ' active' : ''}${pinned ? ' pinned' : ''}`}
      onClick={() => onSelect(session.id)}
      onDoubleClick={() => onRename?.(session.id, session.title)}
      onContextMenu={(e) => {
        if (onDelete) {
          e.preventDefault();
          if (confirm(`Delete "${session.title}" and its messages?`)) {
            onDelete(session.id);
          }
        }
      }}
      title="Double-click to rename · right-click to delete"
    >
      <div class="t"><AnimatedTitle text={session.title} /></div>
      <div class="s">
        {sources} · {rel}
      </div>
      {onDelete && (
        <button
          class="x-del"
          aria-label={`Delete session ${session.title}`}
          title="Delete session"
          onClick={(e) => {
            e.stopPropagation();
            if (confirm(`Delete "${session.title}" and its messages?`)) {
              onDelete(session.id);
            }
          }}
        >
          ×
        </button>
      )}
      <button
        class={`pin-btn${pinned ? ' pinned' : ''}`}
        aria-label={pinned ? 'Unpin session' : 'Pin session'}
        title={pinned ? 'Unpin' : 'Pin'}
        onClick={(e) => {
          e.stopPropagation();
          onTogglePin(session.id);
        }}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path
            d="M9 4.5V2h1V1H2v1h1v2.5L1.5 8v1h3.75v3h1.5V9H10.5V8L9 4.5Z"
            fill="currentColor"
          />
        </svg>
      </button>
    </div>
  );
}

function relativeTime(iso: string): string {
  const ts = Date.parse(iso.replace(' ', 'T') + 'Z');
  if (Number.isNaN(ts)) return iso;
  const deltaSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (deltaSec < 60) return 'just now';
  const min = Math.floor(deltaSec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return iso.slice(0, 10); // YYYY-MM-DD
}