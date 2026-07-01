import { render } from 'preact';
import { App } from './App';

// Vite serves /src/main.tsx as the entry; the build replaces this with
// an inlined <script> in web/dist/index.html (via vite-plugin-singlefile).
const root = document.getElementById('app');
if (!root) throw new Error('#app root not found');
render(<App />, root);
