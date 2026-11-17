/**
 * `pnpm demo:tunnel`: shares the portal from this Mac through a free Cloudflare quick tunnel (D-031).
 * No account, no card, no domain. FAKE DATA ONLY. The link works only while this keeps running.
 *
 *   internet ──https──▶ cloudflared ──▶ password proxy :8080 ─┬─▶ web app :3000 ─▶ API :4000 (demo mode)
 *                                                             └─▶ /inbox  (test inbox, its own password)
 *   API ──smtp──▶ test inbox :2525 (every email and text lands here; nothing is really sent)
 *
 * Needs `pnpm db` running in another terminal and `pnpm dev` stopped.
 * `pnpm demo:tunnel --no-tunnel` runs everything except the tunnel, to check it locally.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createConnection } from 'node:net';
import { arch } from 'node:os';
import { resolve } from 'node:path';
import { simpleParser } from 'mailparser';
import { SMTPServer } from 'smtp-server';
import { checkAccess, type DemoPasswords, linksText } from './demo-auth.js';

const ROOT = resolve(import.meta.dirname, '..');
const DIR = resolve(ROOT, '.dev/demo');
const PROXY_PORT = 8080;
const SMTP_PORT = 2525;
const WEB_PORT = 3000;
const noTunnel = process.argv.includes('--no-tunnel');

process.chdir(ROOT);
process.loadEnvFile('.env');
mkdirSync(DIR, { recursive: true });
const API_PORT = Number(process.env.API_PORT ?? 4000);
const DB_PORT = Number(process.env.DB_PORT);

const children: ChildProcess[] = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.pid && c.exitCode === null) { try { process.kill(-c.pid, 'SIGTERM'); } catch { /* gone */ } }
  setTimeout(() => process.exit(code), 1500);
}
process.on('SIGINT', () => { console.log('\nStopping the demo…'); stop(0); });
process.on('SIGTERM', () => stop(0));

function fail(message: string): never {
  console.error(`\n${message}`);
  stopping = true;
  for (const c of children) if (c.pid && c.exitCode === null) { try { process.kill(-c.pid, 'SIGTERM'); } catch { /* gone */ } }
  process.exit(1);
}

const portOpen = (port: number) => new Promise<boolean>((done) => {
  const s = createConnection({ host: '127.0.0.1', port });
  s.once('connect', () => { s.destroy(); done(true); });
  s.once('error', () => done(false));
});

async function waitFor(what: string, check: () => Promise<boolean>, seconds: number, log?: string) {
  for (let i = 0; i < seconds; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const tail = log && existsSync(log) ? `\n--- ${log} ---\n${readFileSync(log, 'utf8').split('\n').slice(-40).join('\n')}` : '';
  fail(`${what} did not start.${tail}`);
}

const ok = (url: string) => async () => { try { return (await fetch(url)).ok; } catch { return false; } };

function run(name: string, cmd: string, args: string[], env: Record<string, string> = {}, cwd = ROOT) {
  const log = resolve(DIR, `${name}.log`);
  const out = createWriteStream(log);
  const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.pipe(out);
  child.stderr!.pipe(out);
  child.on('exit', (code) => { if (!stopping) fail(`${name} stopped unexpectedly (exit ${code}). See ${log}`); });
  children.push(child);
  return { child, log };
}

// Keep the Mac from idle-sleeping while the demo runs (macOS built-in; closing the lid still sleeps).
spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' }).on('error', () => {});

// ---- 1. Checks -------------------------------------------------------------------------------------
if (!(await portOpen(DB_PORT))) fail(`The database isn't running. Start it in another terminal with: pnpm db`);
for (const [port, what] of [[WEB_PORT, 'the web app'], [API_PORT, 'the API'], [PROXY_PORT, 'the password proxy'], [SMTP_PORT, 'the test inbox']] as const) {
  if (await portOpen(port)) fail(`Port ${port} (${what}) is already in use. Stop \`pnpm dev\` or the other demo first.`);
}
if (!existsSync('.dev/seed-credentials.md')) fail('No fake accounts yet. Run: pnpm seed');

// ---- 2. Passwords (kept in .dev, never committed) ------------------------------------------------------
const pwFile = resolve(ROOT, '.dev/demo-passwords.env');
if (!existsSync(pwFile)) {
  const gen = () => randomBytes(12).toString('base64url');
  writeFileSync(pwFile, `# Vittora demo tunnel passwords. Keep private.\nSITE_USER=client\nSITE_PASS=${gen()}\nINBOX_USER=inbox\nINBOX_PASS=${gen()}\n`, { mode: 0o600 });
}
const pw = Object.fromEntries(readFileSync(pwFile, 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => l.split(/=(.*)/s).slice(0, 2))) as unknown as DemoPasswords;

// ---- 3. Test inbox: a local SMTP receiver, kept in memory ---------------------------------------------
interface Msg { at: string; to: string; subject: string; text: string }
const inbox: Msg[] = [];
const smtp = new SMTPServer({
  authOptional: true, disabledCommands: ['STARTTLS'], banner: 'Vittora demo inbox', size: 1_000_000,
  onConnect(session, cb) { cb(session.remoteAddress === '127.0.0.1' || session.remoteAddress === '::1' || session.remoteAddress === '::ffff:127.0.0.1' ? undefined : new Error('Local only')); },
  onData(stream, _session, cb) {
    simpleParser(stream).then((m) => {
      const to = [m.to].flat().map((a) => (a && 'text' in a ? a.text : '')).join(', ');
      inbox.unshift({ at: new Date().toISOString(), to, subject: m.subject ?? '', text: m.text ?? '' });
      inbox.length = Math.min(inbox.length, 500);
      cb();
    }, (err) => cb(err as Error));
  },
});
await new Promise<void>((r) => smtp.listen(SMTP_PORT, '127.0.0.1', r));

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const linkify = (s: string) => esc(s).replace(/https:\/\/[^\s<]+/g, (u) => `<a href="${u}">${u}</a>`);
const inboxPage = () => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vittora demo inbox</title><meta http-equiv="refresh" content="10">
<style>body{font:15px system-ui,sans-serif;max-width:860px;margin:24px auto;padding:0 16px;color:#1a1a1a;background:#fafafa}
article{background:#fff;border:1px solid #ddd;border-radius:8px;padding:12px 16px;margin:12px 0}
h2{font-size:16px;margin:0 0 4px}small{color:#666}pre{white-space:pre-wrap;word-break:break-word;font:14px ui-monospace,monospace}</style>
<h1>Test inbox</h1><p><small>Every email and text from the demo lands here. Nothing is really sent. Refreshes every 10 seconds.</small></p>
${inbox.length ? inbox.map((m) => `<article><h2>${esc(m.subject)}</h2><small>To ${esc(m.to)} · ${esc(m.at)}</small><pre>${linkify(m.text)}</pre></article>`).join('') : '<p>No messages yet.</p>'}`;

// ---- 4. Password proxy in front of everything ----------------------------------------------------------
const proxy = http.createServer((req, res) => {
  const url = req.url ?? '/';
  const access = checkAccess(url, req.headers.authorization, pw);
  if (!access.ok) {
    res.writeHead(401, { 'www-authenticate': `Basic realm="${access.realm}", charset="UTF-8"`, 'content-type': 'text/plain' });
    return res.end('Password required.');
  }
  if (access.inbox) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" });
    return res.end(inboxPage());
  }
  if (url.startsWith('/api/v1/dev/')) { res.writeHead(404); return res.end(); }
  const headers = { ...req.headers };
  delete headers.authorization;
  const upstream = http.request({ host: '127.0.0.1', port: WEB_PORT, method: req.method, path: url, headers }, (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers);
    up.pipe(res);
  });
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('The demo app is not responding.'); });
  req.pipe(upstream);
});
await new Promise<void>((r) => proxy.listen(PROXY_PORT, '127.0.0.1', r));

// ---- 5. The public link ----------------------------------------------------------------------------------
async function cloudflaredPath() {
  for (const p of ['cloudflared', '/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared']) {
    try { execFileSync(p, ['--version'], { stdio: 'ignore' }); return p; } catch { /* try next */ }
  }
  const local = resolve(ROOT, '.dev/tools/cloudflared');
  if (existsSync(local)) return local;
  const asset = `cloudflared-darwin-${arch() === 'arm64' ? 'arm64' : 'amd64'}.tgz`;
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`;
  console.log(`Downloading Cloudflare's tunnel tool once, from ${url}`);
  mkdirSync(resolve(ROOT, '.dev/tools'), { recursive: true });
  const res = await fetch(url);
  if (!res.ok) fail(`Could not download cloudflared (${res.status}). Download ${asset} from github.com/cloudflare/cloudflared/releases and put the cloudflared file in .dev/tools/`);
  const tgz = resolve(ROOT, `.dev/tools/${asset}`);
  writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
  execFileSync('tar', ['-xzf', tgz, '-C', resolve(ROOT, '.dev/tools')]);
  execFileSync('chmod', ['+x', local]);
  return local;
}

let origin = 'https://demo.localhost';
if (!noTunnel) {
  const bin = await cloudflaredPath();
  const { child, log } = run('cloudflared', bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${PROXY_PORT}`]);
  origin = await new Promise<string>((done) => {
    let buf = '';
    const timer = setTimeout(() => fail(`The tunnel did not give a link within 60 seconds. See ${log}`), 60_000);
    const look = (d: Buffer) => {
      buf += d.toString();
      const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(buf);
      if (m) { clearTimeout(timer); done(m[0]); }
    };
    child.stdout!.on('data', look);
    child.stderr!.on('data', look);
  });
}

// ---- 6. API in demo mode, and the web app ----------------------------------------------------------------
const demoEnv = {
  DEPLOY_MODE: 'demo', DEV_MAILBOX: 'false', WEB_ORIGIN: origin, API_HOST: '127.0.0.1',
  SMTP_URL: `smtp://127.0.0.1:${SMTP_PORT}`, MAIL_FROM: 'Vittora Demo <no-reply@vittora.demo>',
};
const api = run('api', 'pnpm', ['start'], demoEnv, resolve(ROOT, 'apps/api'));
console.log('Building the web app (about a minute)…');
// next build rewrites these two files to point at its output folder; put them back afterwards.
const kept = ['apps/web/tsconfig.json', 'apps/web/next-env.d.ts'].map((f) => [f, readFileSync(f, 'utf8')] as const);
try {
  execFileSync('pnpm', ['--filter', '@vittora/web', 'build'], { env: { ...process.env, NEXT_DIST_DIR: '.next-demo', NODE_ENV: 'production' }, stdio: ['ignore', 'ignore', 'pipe'] });
  for (const [f, text] of kept) writeFileSync(f, text);
} catch (err) {
  for (const [f, text] of kept) writeFileSync(f, text);
  fail(`The web app did not build.\n${String((err as { stderr?: Buffer }).stderr ?? err).slice(-3000)}`);
}
const web = run('web', 'pnpm', ['exec', 'next', 'start', '-H', '127.0.0.1', '-p', String(WEB_PORT)], { NEXT_DIST_DIR: '.next-demo', NODE_ENV: 'production' }, resolve(ROOT, 'apps/web'));
await waitFor('The API', ok(`http://127.0.0.1:${API_PORT}/readyz`), 90, api.log);
await waitFor('The web app', ok(`http://127.0.0.1:${WEB_PORT}/signin`), 90, web.log);

const shared = noTunnel ? `http://127.0.0.1:${PROXY_PORT}` : origin;
writeFileSync(resolve(ROOT, 'links.txt'), linksText(shared, new Date()));

console.log(`
  Vittora demo is live${noTunnel ? ' (local check only, no public link)' : ''}.

  Link:        ${noTunnel ? `http://127.0.0.1:${PROXY_PORT}` : origin}
  Test inbox:  ${noTunnel ? `http://127.0.0.1:${PROXY_PORT}` : origin}/inbox
  Passwords:   .dev/demo-passwords.env   (site: ${pw.SITE_USER}, inbox: ${pw.INBOX_USER})
  App logins:  .dev/seed-credentials.md  (fake accounts)
  All links:   links.txt

  The link changes every time you start this. Keep this terminal open and the Mac awake.
  Press Ctrl+C to stop.
`);
