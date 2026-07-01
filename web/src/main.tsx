import { render } from 'preact';
import { App } from './App';

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

const root = document.getElementById('app');
if (!root) throw new Error('#app root not found');
render(<App />, root);