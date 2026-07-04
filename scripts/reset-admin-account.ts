#!/usr/bin/env -S npx tsx
// reset-admin-account.ts — recover from a lost admin password.
//
// Why: the E2E test suite creates an admin user with a generated
// password; if you've run the suite against your dev volume you
// can't log in. This script is the operator escape hatch — it lives
// on the host (NOT behind an HTTP endpoint) so there's no auth-bypass
// surface area.
//
// What it does:
//   1. Lists every admin in the SQLite users table.
//   2. Prompts the operator to pick one (or pass --user <username>).
//   3. Prompts for a new username (Enter to keep the current one).
//   4. Prompts for a new password (hidden input; ≥12 chars + ≥1
//      non-alphanumeric per the project's password policy).
//   5. Updates the row + wipes that user's auth_sessions so any
//      cached cookie stops working.
//
// What it does NOT touch:
//   - documents table — the admin's owned documents keep their
//     owner_id; ownership is preserved across the reset.
//   - conversations + messages — chat history is untouched.
//   - invites — outstanding invites created by this admin remain
//     valid.
//   - non-admin users.
//
// Idempotency: running it twice with the same flags is fine; the
// second run is a no-op (the password is re-hashed, the sessions
// are wiped again — same end state).
//
// Usage:
//   npm run reset-admin-account                          # interactive
//   npm run reset-admin-account -- --user alice          # target a specific admin (then prompt)
//   npm run reset-admin-account -- --user alice --new-username alicia --new-password '...'   # non-interactive
//
// DB path resolution (in order):
//   $SQLITE_PATH  →  $DOCKHOJ_HOME/db/conversations.db  →  $HOME/.dockhoj/db/conversations.db
//
// If the app is running, stop it first (`docker compose stop app`)
// — SQLite WAL mode queues writes, and "stop the app, run the
// script, restart the app" is the predictable flow.

import Database from 'better-sqlite3';
import { createInterface } from 'node:readline';
import { realpathSync, existsSync, createReadStream } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { hashPassword } from '../src/services/password.js';

// ── ANSI helpers (skip on piped output to keep CI logs clean) ───────────────
const TTY = process.stdout.isTTY;
const c = (code: string, s: string) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s: string) => c('1', s);
const dim = (s: string) => c('2', s);
const green = (s: string) => c('32', s);
const red = (s: string) => c('31', s);
const yellow = (s: string) => c('33', s);
const cyan = (s: string) => c('36', s);

const say = (msg: string) => process.stderr.write(`${msg}\n`);
const info = (msg: string) => say(`${cyan('▸')} ${msg}`);
const ok = (msg: string) => say(`${green('✓')} ${msg}`);
const warn = (msg: string) => say(`${yellow('!')} ${msg}`);
const die = (msg: string) => { say(`${red('✗')} ${msg}`); process.exit(1); };

// ── argv parser (intentionally minimal — no deps) ───────────────────────────
type Args = {
  user?: string;
  newUsername?: string;
  newPassword?: string;
  dbPath?: string;
  help: boolean;
};
function parseArgs(argv: string[]): Args {
  const out: Args = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-h' || a === '--help') out.help = true;
    else if (a === '--user')            { out.user = argv[++i]; if (!out.user) die('--user requires a value'); }
    else if (a.startsWith('--user='))    out.user = a.slice('--user='.length);
    else if (a === '--new-username')     { out.newUsername = argv[++i]; if (!out.newUsername) die('--new-username requires a value'); }
    else if (a.startsWith('--new-username=')) out.newUsername = a.slice('--new-username='.length);
    else if (a === '--new-password')     { out.newPassword = argv[++i]; if (!out.newPassword) die('--new-password requires a value'); }
    else if (a.startsWith('--new-password=')) out.newPassword = a.slice('--new-password='.length);
    else if (a === '--db')               { out.dbPath = argv[++i]; if (!out.dbPath) die('--db requires a value'); }
    else if (a.startsWith('--db='))      out.dbPath = a.slice('--db='.length);
    else die(`Unknown argument: ${a}`);
  }
  return out;
}

function printHelp(): never {
  process.stdout.write(`reset-admin-account — recover from a lost admin password.

Usage:
  npm run reset-admin-account                                  Interactive
  npm run reset-admin-account -- --user <username>             Pick a specific admin, then prompt
  npm run reset-admin-account -- --user <u> --new-username <x> --new-password <p>
                                                              Fully non-interactive (scriptable)

Options:
  --user <username>          Target this specific admin (default: list + prompt)
  --new-username <value>     New username (default: keep current)
  --new-password <value>     New password (default: hidden prompt). Must be
                             ≥12 characters + at least one non-alphanumeric.
  --db <path>                Override SQLite path (otherwise: $SQLITE_PATH →
                             $DOCKHOJ_HOME/db/conversations.db →
                             ~/.dockhoj/db/conversations.db)
  -h, --help                 This help

Side effects:
  - Updates the admin row (username and/or password_hash).
  - DELETEs every row in auth_sessions where user_id matches (caches
    cookies can't be replayed after a credential change).
  - Documents, conversations, messages, invites — UNTOUCHED.

Stop the app before running if it's holding the SQLite write lock:
  docker compose stop app
`);
  process.exit(0);
}

// ── DB path resolution ──────────────────────────────────────────────────────
function resolveDbPath(override?: string): string {
  // --db is authoritative: if the user passed it, it MUST exist.
  if (override) {
    if (!existsSync(override)) {
      die(`--db path does not exist: ${override}`);
    }
    try {
      return realpathSync(override);
    } catch {
      die(`--db path is unreadable: ${override}`);
    }
  }
  const candidates = [
    process.env.SQLITE_PATH,
    process.env.DOCKHOJ_HOME ? join(process.env.DOCKHOJ_HOME, 'db', 'conversations.db') : undefined,
    join(process.env.HOME ?? process.env.USERPROFILE ?? '/tmp', '.dockhoj', 'db', 'conversations.db'),
  ].filter((p): p is string => Boolean(p));
  for (const p of candidates) {
    try {
      if (existsSync(p)) return realpathSync(p);
    } catch { /* permission error → try next */ }
  }
  die(`Could not find the SQLite database. Tried:\n${candidates.map((p) => `  - ${p}`).join('\n')}\nPass --db <path> or set $SQLITE_PATH.`);
}

// ── TTY-aware prompt helpers ────────────────────────────────────────────────
function makeRl(): NodeJS.ReadLine & { close: () => void } {
  // readline against /dev/tty when piped (so the prompt actually
  // reaches the user and the input doesn't get swallowed by the pipe).
  const input: Readable = (existsSync('/dev/tty') && process.stdin.isTTY)
    ? process.stdin
    : createReadStream('/dev/tty');
  return createInterface({ input, output: process.stderr, terminal: true }) as unknown as NodeJS.ReadLine & { close: () => void };
}

function askText(rl: NodeJS.ReadLine & { close: () => void }, prompt: string, defaultValue?: string): Promise<string> {
  return new Promise((resolve) => {
    const suffix = defaultValue ? ` ${dim(`[${defaultValue}]`)}` : '';
    rl.question(`${prompt}${suffix}: `, (answer) => {
      const trimmed = answer.trim();
      resolve(trimmed === '' ? (defaultValue ?? '') : trimmed);
    });
  });
}

function askPassword(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    // Open a fresh readline against /dev/tty (or stdin) with terminal:true
    // — typed characters get echoed as '*' so the password doesn't leak
    // into scrollback.
    const input: Readable = (existsSync('/dev/tty') && process.stdin.isTTY)
      ? process.stdin
      : createReadStream('/dev/tty');
    const mutedRl = createInterface({ input, output: process.stderr, terminal: true });
    mutedRl.question(`${prompt}: `, (answer) => {
      mutedRl.close();
      process.stderr.write('\n');
      resolve(answer);
    });
  });
}

// Same password policy as src/services/auth-session-store.ts
// (FR-25 / p4-T06 / p4-T07): ≥12 chars + ≥1 non-alphanumeric.
function validatePassword(pwd: string): string | null {
  if (pwd.length < 12) return 'password must be at least 12 characters';
  if (!/[^A-Za-z0-9]/.test(pwd)) return 'password must include at least one non-alphanumeric character';
  return null;
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) printHelp();

  const dbPath = resolveDbPath(args.dbPath);
  info(`Using SQLite database: ${bold(dbPath)}`);

  let db: Database.Database;
  try {
    db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
  } catch (err) {
    die(`Could not open the database (${(err as Error).message}). If the app is running, stop it first with \`docker compose stop app\` and try again.`);
  }

  // List admins. The operator picks one.
  const admins = db
    .prepare(`SELECT id, username, role, created_at, last_login_at FROM users WHERE role = 'admin' ORDER BY created_at ASC`)
    .all() as Array<{ id: string; username: string; role: string; created_at: string; last_login_at: string | null }>;

  if (admins.length === 0) {
    db.close();
    die('No admin user found in the database. Visit /register on the app to create the first admin, then re-run.');
  }

  let target: { id: string; username: string } | undefined;
  if (args.user) {
    target = admins.find((a) => a.username === args.user);
    if (!target) {
      db.close();
      die(`No admin with username "${args.user}". Available: ${admins.map((a) => a.username).join(', ')}`);
    }
  } else {
    say('');
    say(bold('Admin users on this volume:'));
    admins.forEach((a, i) => {
      const lastSeen = a.last_login_at ?? dim('(never)');
      say(`  ${dim(`${i + 1}.`)} ${bold(a.username)}  ${dim(`id=${a.id.slice(0, 8)}…  created=${a.created_at}  last_login=${lastSeen}`)}`);
    });
    say('');
    const rl = makeRl();
    const idxStr = await new Promise<string>((resolve) => {
      rl.question(`Which admin to reset? [1-${admins.length}]: `, resolve);
    });
    rl.close();
    const idx = Number(idxStr);
    if (!Number.isInteger(idx) || idx < 1 || idx > admins.length) {
      db.close();
      die(`Invalid selection: ${idxStr}`);
    }
    target = admins[idx - 1]!;
  }

  assert(target);
  say('');
  info(`Target: ${bold(target.username)} ${dim(`(id=${target.id})`)}`);

  // ── gather new credentials ────────────────────────────────────────────────
  const rl = makeRl();
  let newUsername: string;
  if (args.newUsername !== undefined) {
    newUsername = args.newUsername;
  } else {
    newUsername = await askText(rl, 'New username', target.username);
  }
  rl.close();

  if (newUsername.length < 1) {
    db.close();
    die('Username cannot be empty');
  }

  if (newUsername !== target.username) {
    const collision = db.prepare(`SELECT id FROM users WHERE username = ? AND id != ?`).get(newUsername, target.id);
    if (collision) {
      db.close();
      die(`Username "${newUsername}" is already taken by another user. Pick a different name.`);
    }
  }

  let newPassword: string;
  if (args.newPassword !== undefined) {
    newPassword = args.newPassword;
  } else {
    if (!process.stdin.isTTY && !existsSync('/dev/tty')) {
      db.close();
      die('No TTY available for the password prompt. Re-run with --new-password=<value> (insecure on shared hosts — prefer an interactive shell).');
    }
    newPassword = await askPassword('New password');
  }
  const passwordError = validatePassword(newPassword);
  if (passwordError) {
    db.close();
    die(passwordError);
  }

  // ── apply ─────────────────────────────────────────────────────────────────
  const passwordHash = await hashPassword(newPassword);

  const tx = db.transaction(() => {
    db.prepare(`UPDATE users SET username = ?, password_hash = ? WHERE id = ?`)
      .run(newUsername, passwordHash, target!.id);
    const sessionDelete = db.prepare(`DELETE FROM auth_sessions WHERE user_id = ?`).run(target!.id);
    return sessionDelete.changes;
  });
  let sessionsWiped = 0;
  try {
    sessionsWiped = tx();
  } catch (err) {
    db.close();
    die(`Database update failed (${(err as Error).message}). Is the app still running? \`docker compose stop app\` and try again.`);
  }
  db.close();

  say('');
  ok(`Username:  ${dim(target.username)} → ${bold(newUsername)}`);
  ok(`Password:  ${dim('(redacted)')} → ${dim('(hashed + stored)')}`);
  ok(`Sessions:  ${dim(`${sessionsWiped} wiped`)}`);
  say('');
  say(dim('Documents owned by this admin + their conversations + invites are untouched.'));
  say(dim('You can now log in with the new credentials. If the app is stopped, bring it back up with `docker compose up -d`.'));
}

function assert(v: unknown): asserts v {
  if (!v) throw new Error('unreachable');
}

main().catch((err) => {
  die((err as Error).message);
});