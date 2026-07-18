#!/usr/bin/env -S npx tsx
// setup-oidc.ts — interactive OIDC provider configuration.
//
// Why: wiring a new OIDC provider used to require hand-editing `.env`
// with the discovery URL, client id/secret, issuer, scopes, allowed/admin
// groups, and the redirect URI. That hunt is error-prone (especially the
// redirect URI, which must match exactly what the IdP allowlists).
// This script is the operator escape hatch — it lives on the host (NOT
// behind an HTTP endpoint) and walks through the four steps:
//
//   1. Ask for the APP_BASE_URL → print the exact redirect URI to
//      register at the IdP.
//   2. Operator creates the client at the IdP (paste redirect URI,
//      copy client id + secret).
//   3. Ask for the discovery URL + client id + secret (secret typed
//      hidden on TTY). Fetch the discovery doc, validate the required
//      endpoints exist, then ask for the optional access/admin groups +
//      groups claim + provider name.
//   4. Confirm the summary → rewrite `.env` via the pure
//      `rewriteEnvFile` helper (T11). Only OIDC keys are written;
//      everything else byte-preserved.
//
// Re-run to update the OIDC keys in place (idempotent).
//
// Usage:
//   npm run setup-oidc                                            # interactive
//   npm run setup-oidc -- --base-url https://dockhoj.example.com \
//                        --discovery-url https://idp.example.com/.well-known/openid-configuration \
//                        --client-id dockhoj \
//                        --client-secret '...' \
//                        --allowed-group dockhoj-users \
//                        --admin-group dockhoj-admins \
//                        --non-interactive
//
// If the app is running, stop it first (`docker compose stop app`)
// so a `./restart.sh` after this script picks up the new env.

import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { rewriteEnvFile } from '../src/services/dotenv-rewrite.js';

// ── ANSI helpers (TTY-gated, mirrors reset-admin-account) ───────────────
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

// ── argv parser ──────────────────────────────────────────────────────────
type Args = {
  baseUrl?: string;
  discoveryUrl?: string;
  clientId?: string;
  clientSecret?: string;
  allowedGroup?: string;
  adminGroup?: string;
  groupsClaim?: string;
  providerName?: string;
  tokenAuthMethod?: 'client_secret_post' | 'client_secret_basic';
  envPath?: string;
  nonInteractive: boolean;
  help: boolean;
};
function parseArgs(argv: string[]): Args {
  const out: Args = { nonInteractive: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) die(`${a} requires a value`);
      return v;
    };
    if (a === '-h' || a === '--help') out.help = true;
    else if (a === '--base-url')            out.baseUrl = next();
    else if (a.startsWith('--base-url='))   out.baseUrl = a.slice('--base-url='.length);
    else if (a === '--discovery-url')       out.discoveryUrl = next();
    else if (a.startsWith('--discovery-url=')) out.discoveryUrl = a.slice('--discovery-url='.length);
    else if (a === '--client-id')           out.clientId = next();
    else if (a.startsWith('--client-id='))  out.clientId = a.slice('--client-id='.length);
    else if (a === '--client-secret')       out.clientSecret = next();
    else if (a.startsWith('--client-secret=')) out.clientSecret = a.slice('--client-secret='.length);
    else if (a === '--allowed-group')       out.allowedGroup = next();
    else if (a.startsWith('--allowed-group=')) out.allowedGroup = a.slice('--allowed-group='.length);
    else if (a === '--admin-group')         out.adminGroup = next();
    else if (a.startsWith('--admin-group=')) out.adminGroup = a.slice('--admin-group='.length);
    else if (a === '--groups-claim')        out.groupsClaim = next();
    else if (a.startsWith('--groups-claim=')) out.groupsClaim = a.slice('--groups-claim='.length);
    else if (a === '--provider-name')       out.providerName = next();
    else if (a.startsWith('--provider-name=')) out.providerName = a.slice('--provider-name='.length);
    else if (a === '--token-auth-method')   {
      const v = next();
      if (v !== 'client_secret_post' && v !== 'client_secret_basic') {
        die(`--token-auth-method must be client_secret_post or client_secret_basic (got "${v}")`);
      }
      out.tokenAuthMethod = v;
    } else if (a.startsWith('--token-auth-method=')) {
      const v = a.slice('--token-auth-method='.length);
      if (v !== 'client_secret_post' && v !== 'client_secret_basic') {
        die(`--token-auth-method must be client_secret_post or client_secret_basic (got "${v}")`);
      }
      out.tokenAuthMethod = v;
    } else if (a === '--env')               out.envPath = next();
    else if (a.startsWith('--env='))        out.envPath = a.slice('--env='.length);
    else if (a === '--non-interactive' || a === '-y' || a === '--yes') out.nonInteractive = true;
    else die(`Unknown argument: ${a}`);
  }
  return out;
}

function printHelp(): never {
  process.stdout.write(`setup-oidc — configure OIDC single sign-on for DocKhoj.

Usage:
  npm run setup-oidc                                             Interactive (4 steps)
  npm run setup-oidc -- --base-url <url> --discovery-url <url> \
                        --client-id <id> --client-secret <secret> \
                        --non-interactive                         Scriptable

Required for non-interactive mode:
  --base-url, --discovery-url, --client-id, --client-secret

Optional:
  --allowed-group        Group(s) allowed to log in. Blank = no gate.
                         Comma-separated for multiple.
  --admin-group          Group(s) that map to role=admin.
  --groups-claim         JWT claim path (default "groups")
  --provider-name        Button label (default = issuer host)
  --token-auth-method    client_secret_post (default) or client_secret_basic
  --env <path>           .env path (default ./env)
  -y, --yes, --non-interactive   Don't prompt
`);
  process.exit(0);
}

// ── prompt helpers ───────────────────────────────────────────────────────
function prompt(question: string, fallback?: string): Promise<string> {
  return new Promise((resolveP) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: TTY });
    const suffix = fallback ? ` [${fallback}]` : '';
    rl.question(`${cyan('?')} ${question}${suffix}: `, (answer) => {
      rl.close();
      resolveP(answer.trim());
    });
  });
}

async function promptHidden(question: string): Promise<string> {
  if (!TTY) {
    // Read from stdin verbatim (operator types into a piped shell).
    return prompt(question);
  }
  return new Promise((resolveP, rejectP) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const stdin = process.stdin as unknown as { isRaw?: boolean; setRawMode?: (b: boolean) => void; on: (e: string, cb: (k: Buffer | string) => void) => void; removeAllListeners: (e: string) => void };
    const stdout = process.stdout;
    stdout.write(`${cyan('?')} ${question}: `);
    let value = '';
    const cleanup = () => {
      stdin.removeAllListeners('keypress');
      stdin.setRawMode?.(false);
      rl.close();
    };
    try {
      stdin.setRawMode?.(true);
    } catch (e) {
      rejectP(e as Error);
      return;
    }
    stdin.on('keypress', (_e: string, key: { sequence?: string; name?: string }) => {
      const seq = key.sequence ?? '';
      if (seq === '' || key.name === 'c' && key.sequence === undefined) {
        cleanup();
        stdout.write('\n');
        process.exit(1);
      } else if (seq === '\r' || seq === '\n') {
        cleanup();
        stdout.write('\n');
        resolveP(value);
      } else if (seq === '' || seq === '\b') {
        // backspace
        if (value.length > 0) {
          value = value.slice(0, -1);
          stdout.write('\b \b');
        }
      } else if (seq && seq.length === 1 && seq >= ' ' && seq <= '~') {
        value += seq;
        stdout.write('*');
      }
    });
    process.stdin.on('data', (chunk: Buffer) => {
      // Some TTYs route printable input here too — mirror it as '*'.
      const s = chunk.toString('utf8');
      for (const ch of s) {
        if (ch === '\n' || ch === '\r') {
          cleanup();
          stdout.write('\n');
          resolveP(value);
          return;
        }
        if (ch === '') { cleanup(); stdout.write('\n'); process.exit(1); }
        if (ch === '' || ch === '\b') {
          if (value.length > 0) { value = value.slice(0, -1); stdout.write('\b \b'); }
        } else if (ch >= ' ' && ch <= '~') {
          value += ch; stdout.write('*');
        }
      }
    });
    rl.on('SIGINT', () => { cleanup(); stdout.write('\n'); process.exit(1); });
  });
}

// ── discovery fetch + validation ─────────────────────────────────────────
interface DiscoveryDoc {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

async function fetchDiscovery(url: string): Promise<DiscoveryDoc> {
  info(`Fetching ${dim(url)}`);
  const res = await fetch(url);
  if (!res.ok) die(`Discovery fetch failed: HTTP ${res.status} ${res.statusText}`);
  const doc = (await res.json()) as Partial<DiscoveryDoc>;
  if (!doc.issuer || !doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
    die(`Discovery doc is missing one of issuer/authorization_endpoint/token_endpoint/jwks_uri`);
  }
  return doc as DiscoveryDoc;
}

function hostOfIssuer(issuer: string): string {
  try { return new URL(issuer).host || 'SSO'; } catch { return 'SSO'; }
}

// ── .env path resolution ─────────────────────────────────────────────────
function resolveEnvPath(args: Args): string {
  if (args.envPath) return resolve(args.envPath);
  return resolve(process.cwd(), '.env');
}

// ── main flow ────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) printHelp();

  say(`${bold('DocKhoj OIDC setup')}`);
  say('');

  // Step 1: base URL → redirect URI.
  let baseUrl = args.baseUrl;
  if (!baseUrl) {
    if (args.nonInteractive) die('--base-url is required in --non-interactive mode');
    baseUrl = await prompt('App base URL (where DocKhoj is reachable, e.g. https://dockhoj.example.com)');
  }
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') die(`Base URL must be http(s); got "${u.protocol}"`);
  } catch {
    die(`Base URL is not a valid URL: ${baseUrl}`);
  }
  if (baseUrl.startsWith('http://') && !args.nonInteractive) {
    warn('Base URL is http:// — production OIDC requires HTTPS. Continuing for local testing.');
  }
  const redirectUri = baseUrl.replace(/\/+$/, '') + '/api/auth/oidc/callback';

  say('');
  say(`${bold('Step 1 of 4 — Register the redirect URI at your IdP')}`);
  say('');
  say(`  ${bold('Redirect URI:')} ${cyan(redirectUri)}`);
  say('');
  say(`  Create a new OIDC client at your provider. Paste this URI into the`);
  say(`  "redirect URI" / "callback URL" field, copy the issued client id`);
  say(`  and client secret, then continue.`);
  say('');

  if (!args.nonInteractive) {
    await prompt('Press Enter once you have the client id and secret ready', 'Enter');
  }

  // Step 3: discovery + client id + secret + optional gates.
  let discoveryUrl = args.discoveryUrl;
  if (!discoveryUrl) {
    if (args.nonInteractive) die('--discovery-url is required in --non-interactive mode');
    discoveryUrl = await prompt('OIDC discovery URL (e.g. https://idp.example.com/.well-known/openid-configuration)');
  }
  const discovery = await fetchDiscovery(discoveryUrl);

  let clientId = args.clientId;
  if (!clientId) {
    if (args.nonInteractive) die('--client-id is required in --non-interactive mode');
    clientId = await prompt('Client id');
  }

  let clientSecret = args.clientSecret;
  if (!clientSecret) {
    if (args.nonInteractive) die('--client-secret is required in --non-interactive mode');
    clientSecret = await promptHidden('Client secret (hidden)');
  }
  if (!clientSecret) die('Client secret is required');

  let allowedGroup = args.allowedGroup;
  if (allowedGroup === undefined) {
    if (args.nonInteractive) allowedGroup = '';
    else allowedGroup = await prompt('Allowed group (blank = no gate; comma-separated for multiple)', '');
  }

  let adminGroup = args.adminGroup;
  if (adminGroup === undefined) {
    if (args.nonInteractive) adminGroup = '';
    else adminGroup = await prompt('Admin group (members get role=admin; blank = none)', '');
  }

  let groupsClaim = args.groupsClaim;
  if (!groupsClaim) {
    if (args.nonInteractive) groupsClaim = 'groups';
    else groupsClaim = await prompt('Groups claim (default: groups)', 'groups');
  }

  let providerName = args.providerName;
  if (!providerName) {
    if (args.nonInteractive) providerName = hostOfIssuer(discovery.issuer);
    else {
      const ans = await prompt(`Provider name (button label, default: ${hostOfIssuer(discovery.issuer)})`, hostOfIssuer(discovery.issuer));
      providerName = ans || hostOfIssuer(discovery.issuer);
    }
  }

  const tokenAuthMethod: 'client_secret_post' | 'client_secret_basic' =
    args.tokenAuthMethod ?? 'client_secret_post';

  // Step 4: confirm + write.
  say('');
  say(`${bold('Step 4 of 4 — Confirm and write .env')}`);
  say('');
  say(`  ${bold('Discovery:')} ${dim(discovery.issuer)}`);
  say(`  ${bold('Authorization endpoint:')} ${dim(discovery.authorization_endpoint)}`);
  say(`  ${bold('Token endpoint:')}        ${dim(discovery.token_endpoint)}`);
  say(`  ${bold('JWKS URI:')}              ${dim(discovery.jwks_uri)}`);
  say('');
  say(`  ${bold('Redirect URI:')}  ${cyan(redirectUri)}`);
  say(`  ${bold('Client id:')}     ${dim(clientId)}`);
  say(`  ${bold('Client secret:')} ${dim('*'.repeat(Math.max(clientSecret.length, 8)))}`);
  say(`  ${bold('Allowed group:')} ${allowedGroup || dim('(none — no gate)')}`);
  say(`  ${bold('Admin group:')}   ${adminGroup || dim('(none)')}`);
  say(`  ${bold('Groups claim:')}  ${groupsClaim}`);
  say(`  ${bold('Provider name:')} ${providerName}`);
  say(`  ${bold('Token auth:')}    ${tokenAuthMethod}`);
  say('');

  if (!args.nonInteractive) {
    const confirm = await prompt('Write these to .env? Type "yes" to confirm', 'no');
    if (confirm.toLowerCase() !== 'yes') {
      die('Aborted — nothing written.');
    }
  }

  const envPath = resolveEnvPath(args);
  if (!existsSync(envPath)) {
    warn(`.env not found at ${envPath}; creating a fresh one with OIDC keys only`);
  }
  const before = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';

  const updates: Record<string, string> = {
    APP_BASE_URL: baseUrl,
    OIDC_ENABLED: 'true',
    OIDC_ISSUER: discovery.issuer,
    OIDC_DISCOVERY_URL: discoveryUrl,
    OIDC_CLIENT_ID: clientId,
    OIDC_CLIENT_SECRET: clientSecret,
    OIDC_SCOPES: 'openid profile email groups',
    OIDC_GROUPS_CLAIM: groupsClaim,
    OIDC_ALLOWED_GROUP: allowedGroup,
    OIDC_ADMIN_GROUP: adminGroup,
    OIDC_PROVIDER_NAME: providerName,
    OIDC_TOKEN_ENDPOINT_AUTH_METHOD: tokenAuthMethod,
  };

  const after = rewriteEnvFile(before, updates);
  writeFileSync(envPath, after, 'utf8');
  ok(`Wrote ${Object.keys(updates).length} OIDC keys to ${dim(envPath)}`);
  if (before.length > 0) say(`  (other lines preserved byte-for-byte)`);
  say('');
  ok(`Setup complete. Run ${bold('./restart.sh')} to pick up the new config.`);
}

main().catch((err) => {
  die(err instanceof Error ? err.message : String(err));
});