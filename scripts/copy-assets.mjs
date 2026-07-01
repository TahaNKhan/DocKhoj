#!/usr/bin/env node
// Copies non-TS assets (currently: SQL migrations) from src/ into dist/
// after `tsc` runs. Plain tsc only handles .ts/.tsx files; the migration
// runner reads SQL files at runtime via fs.readFileSync, so the SQL
// files must end up alongside the compiled JS in dist/db/migrations/.

import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';

const projectRoot = process.cwd();

function copyDir(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src)) {
    const s = join(src, entry);
    const d = join(dst, entry);
    const st = statSync(s);
    if (st.isDirectory()) {
      copyDir(s, d);
    } else {
      mkdirSync(dirname(d), { recursive: true });
      copyFileSync(s, d);
    }
  }
}

const targets = [
  ['src/db/migrations', 'dist/db/migrations'],
];

for (const [src, dst] of targets) {
  try {
    rmSync(dst, { recursive: true, force: true });
    copyDir(join(projectRoot, src), join(projectRoot, dst));
    console.log(`copied ${src} → ${dst}`);
  } catch (err) {
    console.error(`failed to copy ${src} → ${dst}:`, err.message);
    process.exit(1);
  }
}