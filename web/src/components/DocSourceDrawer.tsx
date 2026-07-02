// DocSourceDrawer — drawer mode for "one doc, many chunks" (p3-T18).
//
// Companion to SourceDrawer (which still handles the single-chunk
// case). Renders a list of chunks for a single document; clicking a
// chunk in the list swaps the rendered markdown below.
//
// Closing: ESC key (mounted effect listens on `window`), backdrop
// click, × button click — same affordances as SourceDrawer.

import { useEffect, useState } from 'preact/hooks';
import type { Source, DocSourceGroup } from './Bubble';
import { renderMarkdown } from '../services/markdown';

interface Props {
  /** A grouped set of chunks for one document. Null = drawer closed. */
  docSources: DocSourceGroup | null;
  onClose: () => void;
}

export function DocSourceDrawer({ docSources, onClose }: Props) {
  // The active chunk is local component state — defaults to the
  // first chunk (which the route handler groups in citation order)
  // and switches when the user picks a different one from the list.
  const [activeIndex, setActiveIndex] = useState(0);

  // Reset to the first chunk whenever a different doc group is opened.
  // Without this, opening doc B after doc A keeps the previously
  // selected index — which can point past the end of doc B's array
  // and render `undefined` below.
  useEffect(() => {
    setActiveIndex(0);
  }, [docSources]);

  // ESC closes. Wired at mount time only — the effect depends on
  // `onClose` which is stable (parent sets it via useCallback or
  // passing the same closure) for the lifetime of the component.
  useEffect(() => {
    if (!docSources) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [docSources, onClose]);

  if (!docSources) return null;
  const { fileName, filePath, chunks } = docSources;
  if (chunks.length === 0) return null;

  const active = chunks[Math.min(activeIndex, chunks.length - 1)] as Source;

  const downloadHref = filePath
    ? `/api/download/${encodeURIComponent(filePath)}`
    : null;

  return (
    <>
      <div class="drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <aside
        class="source-drawer doc-source-drawer"
        role="complementary"
        aria-label={`Source detail for ${fileName}`}
      >
        <header class="drawer-head">
          <div class="meta">
            <div class="title">
              <span class="src-tag">[{active.number}]</span> {fileName}
              <span class="page"> · {chunks.length} chunk{chunks.length === 1 ? '' : 's'}</span>
            </div>
            {active.headingPath && active.headingPath.length > 0 && (
              <div class="crumbs">
                {active.headingPath.map((h, i) => (
                  <span key={i} class="crumb">
                    {h}
                    {i < active.headingPath!.length - 1 && (
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

        <nav class="doc-chunk-list" aria-label="Chunks for this document">
          {chunks.map((c, i) => {
            const isActive = i === activeIndex;
            const crumb = c.headingPath && c.headingPath.length > 0
              ? c.headingPath[c.headingPath.length - 1]
              : null;
            return (
              <button
                key={c.id}
                class={`doc-chunk-row${isActive ? ' active' : ''}`}
                aria-current={isActive ? 'true' : 'false'}
                onClick={() => setActiveIndex(i)}
                type="button"
              >
                <span class="doc-chunk-num">[{i + 1}]</span>
                {c.page ? (
                  <span class="doc-chunk-page">{c.page}</span>
                ) : (
                  <span class="doc-chunk-page doc-chunk-page--empty">—</span>
                )}
                {crumb && (
                  <span class="doc-chunk-crumb">{crumb}</span>
                )}
                <span class="doc-chunk-score">{c.score.toFixed(3)}</span>
              </button>
            );
          })}
        </nav>

        <div class="drawer-body">
          <div
            class="chunk"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(active.chunk) }}
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
          <span class="score">score {active.score.toFixed(3)}</span>
        </footer>
      </aside>
    </>
  );
}