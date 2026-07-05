import { useEffect, useRef, useState } from 'preact/hooks';

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

interface Props {
  text: string;
}

export function AnimatedTitle({ text }: Props) {
  const [display, setDisplay] = useState(text);
  const [animating, setAnimating] = useState(false);
  const prevRef = useRef(text);
  const timerRef = useRef(0);

  useEffect(() => {
    if (text === prevRef.current) return;
    prevRef.current = text;

    clearTimeout(timerRef.current);

    const oldText = display;
    const duration = 800;
    const interval = 50;
    const totalFrames = duration / interval;
    const maxLen = Math.max(oldText.length, text.length);
    let frame = 0;

    setAnimating(true);

    function tick() {
      frame++;
      if (frame >= totalFrames) {
        setDisplay(text);
        setAnimating(false);
        return;
      }

      const progress = frame / totalFrames;
      const result: string[] = [];

      for (let i = 0; i < maxLen; i++) {
        if (i >= text.length) {
          result.push('');
        } else {
          const settleAt = 0.2 + 0.6 * (i / maxLen);
          if (progress >= settleAt) {
            result.push(text[i]!);
          } else {
            result.push(CHARS[Math.floor(Math.random() * CHARS.length)]!);
          }
        }
      }

      setDisplay(result.join(''));
      timerRef.current = window.setTimeout(tick, interval);
    }

    tick();

    return () => clearTimeout(timerRef.current);
  }, [text]);

  return (
    <span class={animating ? 'animating-title' : undefined}>
      {display}
    </span>
  );
}
