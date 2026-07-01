import { render } from 'preact';
import { App } from './App';

// Order matters: tokens before base/animations so any selectors that
// consume variables resolve to the right values; animations.css may
// use --accent / --cream from tokens.css.
import './styles/tokens.css';
import './styles/base.css';
import './styles/animations.css';

const root = document.getElementById('app');
if (!root) throw new Error('#app root not found');
render(<App />, root);