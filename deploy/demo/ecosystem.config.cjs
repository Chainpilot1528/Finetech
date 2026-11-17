/* global module, __dirname */
// pm2 process list for the demo server (D-030). Everything listens on 127.0.0.1; only Caddy faces the internet.
const root = `${__dirname}/../..`;

module.exports = {
  apps: [
    {
      // Test inbox: catches every email and text. Shown at https://<host>/inbox behind its own password.
      name: 'vittora-mailpit',
      script: 'mailpit',
      args: '--listen 127.0.0.1:8025 --smtp 127.0.0.1:1025 --webroot /inbox/ --max 1000',
      interpreter: 'none',
    },
    {
      // Postgres 16 kept in .dev/pg. Applies new migrations every time it starts.
      name: 'vittora-db',
      script: 'pnpm',
      args: 'db',
      cwd: root,
      interpreter: 'none',
      kill_timeout: 20000,
    },
    {
      name: 'vittora-api',
      script: 'pnpm',
      args: 'start',
      cwd: `${root}/apps/api`,
      interpreter: 'none',
    },
    {
      name: 'vittora-web',
      script: 'pnpm',
      args: 'start',
      cwd: `${root}/apps/web`,
      interpreter: 'none',
      env: { NODE_ENV: 'production' },
    },
  ],
};
