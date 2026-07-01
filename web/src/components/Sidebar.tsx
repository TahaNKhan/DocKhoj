import type { Conversation } from '../services/sessions';

// Sidebar — Sessions (with active state) + Pinned section + footer
// indicator. T30 replaces the seed list with a real `sessions` prop
// fed from /api/sessions. The "Pinned" section is decorative for now
// (T30+ keeps it on the design canvas but doesn't wire it to the
// backend).

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
  return (
    <aside id="sidebar" class={`side${open ? ' open' : ''}`}>
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
        {sessions.length === 0 && (
          <div class="session" style={{ cursor: 'default' }}>
            <div class="t" style={{ color: 'var(--muted)' }}>
              No sessions yet
            </div>
            <div class="s">click + to start</div>
          </div>
        )}
        {sessions.map((s) => (
          <SessionRow
            key={s.id}
            session={s}
            active={s.id === activeId}
            onSelect={onSelect}
            onRename={onRename}
            onDelete={onDelete}
          />
        ))}
      </div>

      <div>
        <h4>Pinned</h4>
        <div class="session" style={{ cursor: 'default' }}>
          <div class="t" style={{ color: 'var(--muted)' }}>
            —
          </div>
          <div class="s">no pinned items</div>
        </div>
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
  onSelect: (id: string) => void;
  onRename?: (id: string, currentTitle: string) => void;
  onDelete?: (id: string) => void;
}

function SessionRow({ session, active, onSelect, onRename, onDelete }: RowProps) {
  // Lightweight relative-time string from the ISO updated_at. Kept
  // simple — the design's "2h ago" / "yesterday" / "jan 12" format is
  // mockup-only; this is functional.
  const rel = relativeTime(session.updatedAt);
  const sources = session.messageCount > 0 ? `${session.messageCount} msgs` : 'empty';

  return (
    <div
      class={`session${active ? ' active' : ''}`}
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
      <div class="t">{session.title}</div>
      <div class="s">
        {sources} · {rel}
      </div>
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