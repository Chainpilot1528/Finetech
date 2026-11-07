import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

/** Creates a local .env with fresh random secrets. Nothing here ever leaves this machine. */
mkdirSync('.dev', { recursive: true });
if (existsSync('.env')) {
  console.log('.env already exists, leaving it alone.');
} else {
  const secret = () => randomBytes(18).toString('hex');
  const port = 54330;
  const [admin, owner, app, auth] = [secret(), secret(), secret(), secret()];
  writeFileSync('.env', [
    'NODE_ENV=development', 'API_PORT=4000', 'WEB_ORIGIN=http://localhost:3000',
    `DB_PORT=${port}`, `DB_ADMIN_PASSWORD=${admin}`, `DB_OWNER_PASSWORD=${owner}`,
    `DB_APP_PASSWORD=${app}`, `DB_AUTH_PASSWORD=${auth}`,
    `OWNER_DATABASE_URL=postgres://vittora_owner:${owner}@127.0.0.1:${port}/vittora`,
    `APP_DATABASE_URL=postgres://vittora_app:${app}@127.0.0.1:${port}/vittora`,
    `AUTH_DATABASE_URL=postgres://vittora_auth:${auth}@127.0.0.1:${port}/vittora`,
    `ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`, `HMAC_KEY=${randomBytes(32).toString('hex')}`,
    'DEV_MAILBOX=true', 'BREACHED_PASSWORD_CHECK=false', '',
  ].join('\n'), { mode: 0o600 });
  console.log('Created .env');
}
