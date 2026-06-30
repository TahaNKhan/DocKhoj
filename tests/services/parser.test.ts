import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { parseFile } from '../../src/services/parser.js';

describe('parseFile dispatcher', () => {
  it('returns ParsedDocument for a markdown file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'parser-'));
    const file = path.join(dir, 'sample.md');
    await fs.writeFile(file, '# Heading\n\nbody text\n\n## Sub\n\nmore');
    const parsed = await parseFile(file);
    expect(parsed.fileType).toBe('.md');
    expect(parsed.blocks.length).toBeGreaterThan(0);
    expect(parsed.text).toContain('Heading');
    expect(parsed.text).toContain('body text');
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns ParsedDocument for a text file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'parser-'));
    const file = path.join(dir, 'sample.txt');
    await fs.writeFile(file, 'line one\n\nline two');
    const parsed = await parseFile(file);
    expect(parsed.fileType).toBe('.txt');
    expect(parsed.blocks.length).toBe(2);
    expect(parsed.text).toContain('line one');
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('rejects unsupported extensions', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'parser-'));
    const file = path.join(dir, 'sample.xyz');
    await fs.writeFile(file, 'binary data');
    await expect(parseFile(file)).rejects.toThrow(/Unsupported/);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns ParsedDocument with fileName and fileType set', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'parser-'));
    const file = path.join(dir, 'note.md');
    await fs.writeFile(file, '# note');
    const parsed = await parseFile(file);
    expect(parsed.fileName).toBe('note.md');
    expect(parsed.fileType).toBe('.md');
    await fs.rm(dir, { recursive: true, force: true });
  });
});