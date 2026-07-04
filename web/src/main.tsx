import { render } from 'preact';
import { App } from './App';
import { applyTheme, getStoredTheme } from './services/theme';

// Apply the stored or OS-preference theme before the first paint so
// there's no flash of the wrong background.
applyTheme(getStoredTheme());

// CSS import order:
// - tokens.css first (defines the variables everything else consumes)
// - base.css next (reset + body — applies tokens)
// - animations.css next (keyframes + .aurora / .grain / .grid-overlay / .caret / .dot-live)
// - component styles last (consume all of the above)
import './styles/tokens.css';
import './styles/base.css';
import './styles/animations.css';
import './styles/topbar.css';
import './styles/sidebar.css';
import './styles/bubble.css';
import './styles/composer.css';
import './styles/upload.css';
import './styles/auth.css';
import './styles/admin.css';

// Listen for OS theme changes when the user hasn't explicitly chosen.
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', (e) => {
  if (!localStorage.getItem('dockhoj:theme')) {
    applyTheme(e.matches ? 'light' : 'dark');
  }
});

const root = document.getElementById('app');
if (!root) throw new Error('#app root not found');
render(<App />, root);