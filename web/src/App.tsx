// T24 stub — visually exercises the extracted design tokens so a build
// produces a recognizable DocKhoj surface. T25 replaces this with the
// real TopBar / Sidebar / Bubble / Composer / Dropzone / QueueRow
// components and the wouter route table.
//
// What this page proves:
// - tokens.css :root variables are applied (bg / cream / accent / type).
// - base.css reset is wired (no user-agent margins, body is dark).
// - animations.css keyframes + the .aurora / .grain / .grid-overlay
//   background layers paint behind the content.
// - The .dot-live pulse + .caret blink are reachable from JSX.

import { AppShell } from './components/AppShell';

export function App() {
  return <AppShell />;
}