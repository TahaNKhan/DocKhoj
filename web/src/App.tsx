// T23 minimal scaffold — T25 replaces this with the real /chat and /upload
// routes via wouter-preact. For now, a placeholder so `vite build` produces
// a valid web/dist/index.html and `vite dev` serves the bundle on :5173.
export function App() {
  return (
    <div style={{ padding: '32px', fontFamily: 'system-ui' }}>
      <h1>DocKhoj</h1>
      <p>Frontend scaffold (Phase 02 / T23) — real routes come in T25.</p>
    </div>
  );
}
