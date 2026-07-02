// SourceDrawer — inline panel that opens when the user clicks a
// source chip on an assistant bubble (T37). Slides in from the
// right, shows the full chunk text rendered as markdown, plus the
// fileName + page/heading metadata and an "Open file" link to the
// server's `/api/download/:filename` route.
//
// Closing:
//   - ESC key (mounted effect listens on `window`)
//   - Click on the backdrop
//   - Click the explicit × button
//
// The drawer renders next to the chat column when open (it's an
// inline panel, not a full overlay), with a translucent backdrop
// behind it covering the rest of the page. On narrow viewports
// (<720 px) it goes full-width and the backdrop fills the rest.

import { useEffect } from 'preact/hooks';
import type { Source } from './Bubble';
import { renderMarkdown } from '../services/markdown';

interface Props {
  source: Source | null;
  onClose: () => void;
}

export function SourceDrawer({ source, onClose }: Props) {
  // ESC closes. Wired at mount time only — the effect depends on
  // `onClose` which is stable (parent sets it via useCallback or
  // passing the same closure) for the lifetime of the component.
  useEffect(() => {
    if (!source) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [source, onClose]);

  if (!source) return null;

  const downloadHref = source.filePath
    ? `/api/download/${encodeURIComponent(source.filePath)}`
    : null;

  return (
    <>
      <div class="drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <aside
        class="source-drawer"
        role="complementary"
        aria-label="Source detail"
      >
        <header class="drawer-head">
          <div class="meta">
            <div class="title">
              <span class="src-tag">[{source.number}]</span>{' '}
              {source.fileName}
              {source.page && <span class="page"> · {source.page}</span>}
            </div>
            {source.headingPath && source.headingPath.length > 0 && (
              <div class="crumbs">
                {source.headingPath.map((h, i) => (
                  <span key={i} class="crumb">
                    {h}
                    {i < source.headingPath!.length - 1 && (
                      <span class="sep"> › </span>
                    )}
                  </span>
                ))}
              </div>
            )}
          </div>
          <button class="close-x" aria-label="close" onClick={onClose}>
            ×
          </button>
        </header>

        <div class="drawer-body">
          <div
            class="chunk"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(source.chunk) }}
          />
        </div>

        <footer class="drawer-foot">
          {downloadHref && (
            <a
              class="open-file"
              href={downloadHref}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open file →
            </a>
          )}
          <span class="score">
            score {source.score.toFixed(3)}
          </span>
        </footer>
      </aside>
    </>
  );
}