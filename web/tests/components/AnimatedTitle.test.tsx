import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/preact';
import { AnimatedTitle } from '../../src/components/AnimatedTitle';

describe('AnimatedTitle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it('renders initial text without animation class', () => {
    const { container } = render(<AnimatedTitle text="Hello World" />);
    expect(container.textContent).toBe('Hello World');
    expect(container.querySelector('.animating-title')).toBeNull();
  });

  it('shows scrambled text during animation when text changes', () => {
    const { container, rerender } = render(<AnimatedTitle text="Hello" />);
    expect(container.textContent).toBe('Hello');

    rerender(<AnimatedTitle text="World" />);

    // After one frame (50ms) the text should be scrambled.
    // We should see a 5-character string that is neither "Hello" nor "World".
    act(() => { vi.advanceTimersByTime(50); });
    const mid = container.textContent!;
    expect(mid.length).toBe(5);
    expect(mid).not.toBe('Hello');
    expect(mid).not.toBe('World');

    // The animating class should be present.
    expect(container.querySelector('.animating-title')).not.toBeNull();
  });

  it('resolves to the new text when animation completes', () => {
    const { container, rerender } = render(<AnimatedTitle text="Hello" />);
    rerender(<AnimatedTitle text="World" />);

    // Advance past the full 800ms animation.
    act(() => { vi.advanceTimersByTime(900); });

    expect(container.textContent).toBe('World');
    expect(container.querySelector('.animating-title')).toBeNull();
  });

  it('does not animate when text stays the same', () => {
    const { container, rerender } = render(<AnimatedTitle text="Same" />);
    rerender(<AnimatedTitle text="Same" />);

    act(() => { vi.advanceTimersByTime(200); });
    expect(container.textContent).toBe('Same');
    expect(container.querySelector('.animating-title')).toBeNull();
  });

  it('handles empty incoming text gracefully', () => {
    const { container, rerender } = render(<AnimatedTitle text="Delete" />);
    rerender(<AnimatedTitle text="" />);

    act(() => { vi.advanceTimersByTime(900); });
    expect(container.textContent).toBe('');
  });

  it('handles empty outgoing text gracefully', () => {
    const { container, rerender } = render(<AnimatedTitle text="" />);
    rerender(<AnimatedTitle text="Appear" />);

    act(() => { vi.advanceTimersByTime(50); });
    const mid = container.textContent!;
    expect(mid.length).toBeGreaterThan(0);
    expect(container.querySelector('.animating-title')).not.toBeNull();

    act(() => { vi.advanceTimersByTime(900); });
    expect(container.textContent).toBe('Appear');
  });

  it('cancels in-progress animation when text changes again', () => {
    const { container, rerender } = render(<AnimatedTitle text="Hello" />);

    // Start first animation.
    rerender(<AnimatedTitle text="World" />);
    act(() => { vi.advanceTimersByTime(100); });
    const mid1 = container.textContent!;
    expect(mid1).not.toBe('Hello');
    expect(mid1).not.toBe('World');

    // Interrupt with a different title.
    rerender(<AnimatedTitle text="Foo" />);

    // The animation should now be heading to "Foo". After a short time
    // it should be scrambled but not the final text.
    act(() => { vi.advanceTimersByTime(100); });
    const mid2 = container.textContent!;
    expect(mid2).not.toBe('Foo');
    expect(container.querySelector('.animating-title')).not.toBeNull();

    // Complete the animation.
    act(() => { vi.advanceTimersByTime(800); });
    expect(container.textContent).toBe('Foo');
    expect(container.querySelector('.animating-title')).toBeNull();
  });

  it('cleans up timers on unmount', () => {
    const { unmount, rerender } = render(<AnimatedTitle text="Hello" />);
    rerender(<AnimatedTitle text="World" />);
    unmount();

    // No crash after unmounting mid-animation.
    act(() => { vi.advanceTimersByTime(900); });
  });
});
