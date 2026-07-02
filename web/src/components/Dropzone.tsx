import { useState } from 'preact/hooks';

// Dropzone — drag-drop or click. p2-T04 ships the visual + intent; p2-T15
// wires POST /api/upload + GET /api/upload/progress.

interface Props {
  onFiles?: (files: File[]) => void;
}

const FORMATS = ['PDF', 'MD', 'TXT', 'EPUB', 'URL'];

export function Dropzone({ onFiles }: Props) {
  const [drag, setDrag] = useState(false);

  function pickFiles() {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = '.pdf,.md,.markdown,.txt,.epub,.text';
    input.addEventListener('change', () => {
      if (input.files) onFiles?.(Array.from(input.files));
    });
    input.click();
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDrag(false);
    const files = e.dataTransfer?.files;
    if (files && files.length) onFiles?.(Array.from(files));
  }

  return (
    <div
      class={`dropzone-big${drag ? ' drag' : ''}`}
      onClick={pickFiles}
      onDragEnter={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={onDrop}
      role="button"
      tabIndex={0}
    >
      <div class="dz-orb">
        <span class="arr">↓</span>
      </div>
      <h2>
        Drop files <i>here</i>
      </h2>
      <div class="sub">or click to browse</div>
      <div class="formats">
        {FORMATS.map((f) => (
          <span key={f} class="fmt">
            {f}
          </span>
        ))}
      </div>
    </div>
  );
}
