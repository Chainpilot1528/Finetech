#!/usr/bin/env bash
# Brings the demo server up to date with its branch (D-030). Usage: bash deploy/demo/update.sh
set -euo pipefail
cd "$HOME/vittora"
git pull --ff-only
pnpm install --frozen-lockfile
pnpm --filter @vittora/web build
# Restarting the database applies any new migrations.
pm2 restart vittora-db
DB_PORT="$(grep '^DB_PORT=' .env | cut -d= -f2)"
for _ in $(seq 1 90); do (echo >"/dev/tcp/127.0.0.1/$DB_PORT") 2>/dev/null && break; sleep 2; done
sleep 5
pm2 restart vittora-api vittora-web
for _ in $(seq 1 60); do curl -fs http://127.0.0.1:4000/readyz >/dev/null && break; sleep 2; done
curl -fs http://127.0.0.1:4000/readyz >/dev/null && echo "Updated." || { pm2 logs --lines 50 --nostream; exit 1; }
