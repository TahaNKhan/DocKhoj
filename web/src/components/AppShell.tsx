// T24 stub shell — exercises design tokens. Replaced by the real
// TopBar / Sidebar / chat area in T25.

const containerStyle = {
  position: 'relative' as const,
  zIndex: 2,
  maxWidth: 720,
  margin: '0 auto',
  padding: '80px var(--pad)',
};

const eyebrowStyle = {
  fontFamily: 'var(--f-mono)',
  fontSize: 11,
  letterSpacing: '0.28em',
  color: 'var(--muted)',
  textTransform: 'uppercase' as const,
  marginBottom: 18,
  display: 'inline-flex' as const,
  alignItems: 'center' as const,
  gap: 10,
};

const headingStyle = {
  fontFamily: 'var(--f-display)',
  fontSize: 'clamp(40px, 5.5vw, 72px)',
  lineHeight: 1,
  letterSpacing: '-0.02em',
  fontWeight: 500,
  marginBottom: 16,
  color: 'var(--cream)',
};

const bodyStyle = {
  color: 'var(--fg-soft)',
  fontSize: 16,
  lineHeight: 1.6,
  maxWidth: 520,
};

const liveRowStyle = {
  marginTop: 32,
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  fontFamily: 'var(--f-mono)',
  fontSize: 11,
  letterSpacing: '0.18em',
  color: 'var(--muted)',
  textTransform: 'uppercase' as const,
};

const caretDemoStyle = {
  marginTop: 24,
  fontFamily: 'var(--f-body)',
  fontSize: 18,
  color: 'var(--fg)',
};

export function AppShell() {
  return (
    <>
      <div class="aurora" aria-hidden="true" />
      <div class="grain" aria-hidden="true" />
      <div class="grid-overlay" aria-hidden="true" />

      <div style={containerStyle}>
        <div style={eyebrowStyle}>
          <span
            style={{
              width: 24,
              height: 1,
              background: 'var(--accent)',
              display: 'inline-block',
            }}
          />
          Phase 02 / T24
        </div>
        <h1 style={headingStyle}>
          Tokens are <i style={{ color: 'var(--accent)', fontStyle: 'italic', fontWeight: 400 }}>live</i>.
        </h1>
        <p style={bodyStyle}>
          Design tokens, base styles, and animations extracted from the v2 mockups and
          loaded into the SPA shell. The aurora gradient, grain noise, and grid overlay
          paint behind this content. A live status dot and a streaming caret are reachable
          for the components that will use them.
        </p>
        <div style={liveRowStyle}>
          <span class="dot-live" />
          online · tokens applied
        </div>
        <div style={caretDemoStyle}>
          streaming reply<span class="caret" />
        </div>
      </div>
    </>
  );
}