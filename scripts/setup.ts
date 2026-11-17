import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * Creates a local .env with fresh random secrets. Nothing here ever leaves this machine.
 * `pnpm setup:env --demo https://your-demo-host` writes a demo server's .env instead (D-030).
 */
mkdirSync('.dev', { recursive: true });
const demoAt = process.argv.indexOf('--demo');
const demoOrigin = demoAt === -1 ? null : process.argv[demoAt + 1] ?? '';
if (demoOrigin !== null && !/^https:\/\/[a-z0-9.-]+$/i.test(demoOrigin)) {
  console.error('Usage: pnpm setup:env --demo https://your-demo-host');
  process.exit(1);
}
if (existsSync('.env') && demoOrigin !== null && !readFileSync('.env', 'utf8').includes('DEPLOY_MODE=demo')) {
  console.error('.env already exists and is not a demo .env. Move it aside first if this really is the demo server.');
  process.exit(1);
}
if (existsSync('.env')) {
  const current = readFileSync('.env', 'utf8');
  if (!current.includes('DB_OPS_PASSWORD=')) {
    const ops = randomBytes(18).toString('hex');
    const port = /DB_PORT=(\d+)/.exec(current)?.[1];
    appendFileSync('.env', `DB_OPS_PASSWORD=${ops}\nOPS_DATABASE_URL=postgres://vittora_ops:${ops}@127.0.0.1:${port}/vittora\n`);
    console.log('Added the ops database settings to .env');
  } else console.log('.env is up to date.');
} else {
  const secret = () => randomBytes(18).toString('hex');
  const port = 54330;
  const [admin, owner, app, auth, ops] = [secret(), secret(), secret(), secret(), secret()];
  writeFileSync('.env', [
    'NODE_ENV=development', 'API_PORT=4000', `WEB_ORIGIN=${demoOrigin ?? 'http://localhost:3000'}`,
    `DB_PORT=${port}`, `DB_ADMIN_PASSWORD=${admin}`, `DB_OWNER_PASSWORD=${owner}`,
    `DB_APP_PASSWORD=${app}`, `DB_AUTH_PASSWORD=${auth}`, `DB_OPS_PASSWORD=${ops}`,
    `OWNER_DATABASE_URL=postgres://vittora_owner:${owner}@127.0.0.1:${port}/vittora`,
    `APP_DATABASE_URL=postgres://vittora_app:${app}@127.0.0.1:${port}/vittora`,
    `AUTH_DATABASE_URL=postgres://vittora_auth:${auth}@127.0.0.1:${port}/vittora`,
    `OPS_DATABASE_URL=postgres://vittora_ops:${ops}@127.0.0.1:${port}/vittora`,
    `ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`, `HMAC_KEY=${randomBytes(32).toString('hex')}`,
    ...(demoOrigin
      ? ['DEPLOY_MODE=demo', 'DEV_MAILBOX=false', 'SMTP_URL=smtp://127.0.0.1:1025', 'MAIL_FROM=Vittora Demo <no-reply@vittora.demo>']
      : ['DEV_MAILBOX=true']),
    'BREACHED_PASSWORD_CHECK=false', '',
  ].join('\n'), { mode: 0o600 });
  console.log(demoOrigin ? `Created a demo .env for ${demoOrigin}` : 'Created .env');
}
