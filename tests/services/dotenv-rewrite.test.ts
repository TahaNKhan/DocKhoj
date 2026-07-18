import { describe, it, expect } from 'vitest';
import { rewriteEnvFile } from '../../src/services/dotenv-rewrite.js';

describe('rewriteEnvFile', () => {
  it('appends a new key when it does not yet exist', () => {
    const input = 'OPENAI_API_KEY=sk-abc\n';
    const out = rewriteEnvFile(input, { OIDC_CLIENT_ID: 'xxx' });
    expect(out).toBe('OPENAI_API_KEY=sk-abc\nOIDC_CLIENT_ID=xxx\n');
  });

  it('replaces an existing key in place, preserving line position', () => {
    const input =
      '# header\n' +
      'OPENAI_API_KEY=old\n' +
      '\n' +
      'OIDC_CLIENT_ID=old-id\n' +
      'PORT=3001\n';
    const out = rewriteEnvFile(input, { OIDC_CLIENT_ID: 'new-id' });
    expect(out).toBe(
      '# header\n' +
        'OPENAI_API_KEY=old\n' +
        '\n' +
        'OIDC_CLIENT_ID=new-id\n' +
        'PORT=3001\n',
    );
  });

  it('preserves unrelated lines, comments, and blank lines verbatim', () => {
    const input =
      '# auth config\n' +
      '\n' +
      'OPENAI_API_KEY=sk-abc\n' +
      'OIDC_CLIENT_ID=aaa\n' +
      '\n' +
      '# trailing comment\n';
    const out = rewriteEnvFile(input, { OIDC_CLIENT_ID: 'bbb' });
    expect(out).toBe(
      '# auth config\n' +
        '\n' +
        'OPENAI_API_KEY=sk-abc\n' +
        'OIDC_CLIENT_ID=bbb\n' +
        '\n' +
        '# trailing comment\n',
    );
  });

  it('handles a blank value (KEY=)', () => {
    const input = 'OIDC_CLIENT_SECRET=shh\n';
    const out = rewriteEnvFile(input, { OIDC_CLIENT_SECRET: '' });
    expect(out).toBe('OIDC_CLIENT_SECRET=\n');
  });

  it('ends with exactly one trailing newline regardless of input endings', () => {
    // No trailing newline on input.
    expect(rewriteEnvFile('A=1', { B: '2' })).toBe('A=1\nB=2\n');
    // Multiple trailing newlines collapse to one.
    expect(rewriteEnvFile('A=1\n\n\n', { B: '2' })).toBe('A=1\nB=2\n');
    // Trailing blank lines preserved internally, still one final newline.
    expect(rewriteEnvFile('A=1\n\n', { B: '2' })).toBe('A=1\nB=2\n');
  });

  it('keeps stable line order for existing keys and appends new ones after', () => {
    const input = 'A=1\nB=2\n';
    const out = rewriteEnvFile(input, { B: 'x', C: '3', A: 'y' });
    expect(out).toBe('A=y\nB=x\nC=3\n');
  });

  it('does not prefix-match keys (OIDC_CLIENT vs OIDC_CLIENT_ID)', () => {
    // Updating OIDC_CLIENT must NOT rewrite OIDC_CLIENT_ID / _SECRET lines,
    // and the update must be appended since no exact line matched.
    const input =
      'OIDC_CLIENT_ID=abc\n' +
      'OIDC_CLIENT_SECRET=shh\n';
    const out = rewriteEnvFile(input, { OIDC_CLIENT: 'foo' });
    expect(out).toBe(
      'OIDC_CLIENT_ID=abc\n' +
        'OIDC_CLIENT_SECRET=shh\n' +
        'OIDC_CLIENT=foo\n',
    );
  });

  it('normalizes CRLF to LF', () => {
    const input = 'A=1\r\nB=2\r\n';
    const out = rewriteEnvFile(input, { B: 'x' });
    expect(out).toBe('A=1\nB=x\n');
    expect(out.includes('\r')).toBe(false);
  });

  it('handles empty content', () => {
    expect(rewriteEnvFile('', { A: '1' })).toBe('A=1\n');
  });

  it('handles empty updates (returns normalized content)', () => {
    expect(rewriteEnvFile('A=1\n\n\n', {})).toBe('A=1\n');
  });

  it('updates multiple keys across the file in one pass', () => {
    const input =
      'A=1\n' +
      'B=2\n' +
      '# comment\n' +
      'C=3\n';
    const out = rewriteEnvFile(input, { A: 'x', C: 'z', D: '4' });
    expect(out).toBe('A=x\nB=2\n# comment\nC=z\nD=4\n');
  });
});
