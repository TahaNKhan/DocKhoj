import { useState } from 'preact/hooks';

// Sidebar — Sessions (with active state) + Pinned section + footer
// indicator. T25 ships with seed data; T30 wires the list to
// GET /api/sessions and click-to-switch behavior.

interface SessionItem {
  id: string;
  title: string;
  meta: string;
  pinned?: boolean;
}

const SEED_SESSIONS: SessionItem[] = [
  { id: 's1', title: 'Habit loop notes', meta: '12 sources · 2h ago' },
  { id: 's2', title: 'Transformer deep-dive', meta: '8 sources · yesterday' },
  { id: 's3', title: 'Garden spring plan', meta: '3 sources · last week' },
  { id: 's4', title: 'Reading list Q1', meta: '21 sources · jan 12' },
];

const SEED_PINNED: SessionItem[] = [
  { id: 'p1', title: 'On attention mechanisms', meta: 'attention-is-all-you-need.pdf', pinned: true },
  { id: 'p2', title: 'Daily check-in template', meta: 'notes-on-habits.md', pinned: true },
];

interface Props {
  activeId?: string;
  onSelect?: (id: string) => void;
  onCreate?: () => void;
}

export function Sidebar({ activeId = 's1', onSelect, onCreate }: Props) {
  const [active] = useState(activeId);

  return (
    <aside class="side">
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
        {SEED_SESSIONS.map((s) => (
          <div
            key={s.id}
            class={`session${s.id === active ? ' active' : ''}`}
            onClick={() => onSelect?.(s.id)}
          >
            <div class="t">{s.title}</div>
            <div class="s">
              <span class="n">{parseSourcesCount(s.meta)}</span>
              {s.meta}
            </div>
          </div>
        ))}
      </div>

      <div>
        <h4>Pinned</h4>
        {SEED_PINNED.map((s) => (
          <div
            key={s.id}
            class={`session${s.id === active ? ' active' : ''}`}
            onClick={() => onSelect?.(s.id)}
          >
            <div class="t">{s.title}</div>
            <div class="s">{s.meta}</div>
          </div>
        ))}
      </div>

      <div class="side-foot">
        <span>
          embed: <span class="k">nomic-embed-text · 768d</span>
        </span>
      </div>
    </aside>
  );
}

function parseSourcesCount(meta: string): string {
  const m = /(\d+)\s*sources?/.exec(meta);
  return m ? m[1] : '0';
}
