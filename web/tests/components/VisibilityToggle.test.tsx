import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/preact';
import { VisibilityToggle } from '../../src/components/VisibilityToggle';

// p4-T18 — VisibilityToggle component. Covers:
//   1. Renders both radio options with the right labels.
//   2. Default selection is "private".
//   3. Clicking a radio bubbles the change up to the parent.
//   4. The `.on` class reflects `value` (so the styling can show
//      which side is selected without inspecting the input).

describe('VisibilityToggle', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders both Private and Public radios', () => {
    const { container } = render(
      <VisibilityToggle value="private" onChange={() => {}} />
    );
    const inputs = container.querySelectorAll('input[type="radio"]');
    expect(inputs).toHaveLength(2);
    const labels = Array.from(container.querySelectorAll('.vis-opt .vis-label')).map(
      (n) => n.textContent
    );
    expect(labels).toEqual(['Private', 'Public']);
  });

  it('defaults the checked radio to the value prop', () => {
    const { container: c1 } = render(
      <VisibilityToggle value="private" onChange={() => {}} />
    );
    const [privateInput, publicInput] = c1.querySelectorAll(
      'input[type="radio"]'
    ) as NodeListOf<HTMLInputElement>;
    expect(privateInput.checked).toBe(true);
    expect(publicInput.checked).toBe(false);

    cleanup();

    const { container: c2 } = render(
      <VisibilityToggle value="public" onChange={() => {}} />
    );
    const [privateInput2, publicInput2] = c2.querySelectorAll(
      'input[type="radio"]'
    ) as NodeListOf<HTMLInputElement>;
    expect(privateInput2.checked).toBe(false);
    expect(publicInput2.checked).toBe(true);
  });

  it('marks the selected option with the .on class', () => {
    const { container } = render(
      <VisibilityToggle value="public" onChange={() => {}} />
    );
    const opts = container.querySelectorAll('.vis-opt');
    expect(opts[0]!.classList.contains('on')).toBe(false);
    expect(opts[1]!.classList.contains('on')).toBe(true);
  });

  it('calls onChange with the new value when a radio is clicked', () => {
    const onChange = vi.fn();
    const { container } = render(
      <VisibilityToggle value="private" onChange={onChange} />
    );
    const [_, publicInput] = container.querySelectorAll(
      'input[type="radio"]'
    ) as NodeListOf<HTMLInputElement>;
    fireEvent.click(publicInput);
    expect(onChange).toHaveBeenCalledWith('public');
  });

  it('calls onChange("private") when the private radio is clicked', () => {
    const onChange = vi.fn();
    const { container } = render(
      <VisibilityToggle value="public" onChange={onChange} />
    );
    const [privateInput] = container.querySelectorAll(
      'input[type="radio"]'
    ) as NodeListOf<HTMLInputElement>;
    fireEvent.click(privateInput);
    expect(onChange).toHaveBeenCalledWith('private');
  });

  it('respects the disabled prop', () => {
    const { container } = render(
      <VisibilityToggle value="private" onChange={() => {}} disabled />
    );
    const inputs = container.querySelectorAll(
      'input[type="radio"]'
    ) as NodeListOf<HTMLInputElement>;
    expect(inputs[0]!.disabled).toBe(true);
    expect(inputs[1]!.disabled).toBe(true);
  });
});