// VisibilityToggle — Public/Private radio. p4-T18. The parent owns the
// state (Upload.tsx holds `visibility` in useState and threads it into
// uploadFile + the multipart body). This component is presentational:
// it renders two native <input type="radio"> inside a label, so it
// inherits keyboard navigation, focus rings, and screen-reader
// semantics from the platform — no custom widget needed.

export type Visibility = 'public' | 'private';

export interface VisibilityToggleProps {
  value: Visibility;
  onChange: (v: Visibility) => void;
  disabled?: boolean;
}

export function VisibilityToggle({ value, onChange, disabled }: VisibilityToggleProps) {
  return (
    <div class="vis-toggle" role="radiogroup" aria-label="Document visibility">
      <label class={`vis-opt${value === 'private' ? ' on' : ''}`}>
        <input
          type="radio"
          name="visibility"
          value="private"
          checked={value === 'private'}
          disabled={disabled}
          onChange={() => onChange('private')}
        />
        <span class="vis-label">Private</span>
        <span class="vis-sub">only me</span>
      </label>
      <label class={`vis-opt${value === 'public' ? ' on' : ''}`}>
        <input
          type="radio"
          name="visibility"
          value="public"
          checked={value === 'public'}
          disabled={disabled}
          onChange={() => onChange('public')}
        />
        <span class="vis-label">Public</span>
        <span class="vis-sub">all users</span>
      </label>
    </div>
  );
}