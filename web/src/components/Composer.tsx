import { useEffect, useRef, useState } from 'preact/hooks';

// Composer — autosize textarea + send. Enter sends, Shift+Enter inserts
// a newline. p2-T04 ships a no-op submit handler; p2-T13 wires it to the SSE
// stream endpoint.

interface Props {
  placeholder?: string;
  disabled?: boolean;
  onSubmit?: (text: string) => void;
}

export function Composer({
  placeholder = 'Ask across your library…  (Enter to send · Shift+Enter for newline)',
  disabled = false,
  onSubmit,
}: Props) {
  const [value, setValue] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Autosize between 1 and 6 lines.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }, [value]);

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  function submit() {
    const text = value.trim();
    if (!text || disabled) return;
    onSubmit?.(text);
    setValue('');
  }

  return (
    <div class="composer">
      <div class="box">
        <textarea
          ref={taRef}
          rows={1}
          placeholder={placeholder}
          value={value}
          disabled={disabled}
          onInput={(e) => setValue((e.currentTarget as HTMLTextAreaElement).value)}
          onKeyDown={handleKeydown}
        />
        <button class="send" onClick={submit} disabled={disabled || !value.trim()}>
          Send <span class="kbd">↵</span>
        </button>
      </div>
    </div>
  );
}
