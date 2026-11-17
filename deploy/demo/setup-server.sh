#!/usr/bin/env bash
# Sets up a Vittora demo server on a fresh Ubuntu 24.04 machine (D-030). FAKE DATA ONLY.
# Guide: docs/DEMO-DEPLOY.md
#
# Usage: bash setup-server.sh your-name.duckdns.org [branch]
# Safe to run again: it skips what is already done.
set -euo pipefail

HOST="${1:?Usage: bash setup-server.sh your-name.duckdns.org [branch]}"
BRANCH="${2:-main}"
REPO="https://github.com/Chainpilot1528/Finetech.git"
APP_DIR="$HOME/vittora"
LOGINS="$HOME/vittora-demo-passwords.env"

step() { printf '\n== %s\n' "$1"; }

step "System packages"
sudo apt-get update -y
sudo apt-get install -y curl git gnupg openssl debian-keyring debian-archive-keyring apt-transport-https

step "Node 22 and pnpm"
if ! command -v node >/dev/null || [[ "$(node -v)" != v22* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
sudo corepack enable
command -v pm2 >/dev/null || sudo npm install -g pm2

step "Caddy (HTTPS and passwords)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y caddy
fi

step "Mailpit (test inbox)"
command -v mailpit >/dev/null || sudo bash < <(curl -sL https://raw.githubusercontent.com/axllent/mailpit/develop/install.sh)

step "Open ports 80 and 443 in the server's own firewall"
for port in 80 443; do
  sudo iptables -C INPUT -p tcp --dport "$port" -m state --state NEW -j ACCEPT 2>/dev/null \
    || sudo iptables -I INPUT -p tcp --dport "$port" -m state --state NEW -j ACCEPT
done
command -v netfilter-persistent >/dev/null && sudo netfilter-persistent save

step "Get the code ($BRANCH)"
[ -d "$APP_DIR/.git" ] || git clone "$REPO" "$APP_DIR"
cd "$APP_DIR"
git fetch origin
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"
pnpm install --frozen-lockfile
[ -f .env ] || pnpm setup:env --demo "https://$HOST"

step "Build the web app"
pnpm --filter @vittora/web build

step "Passwords for the site and the inbox"
if [ ! -f "$LOGINS" ]; then
  gen() { openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | cut -c1-16; }
  umask 077
  printf '# Vittora demo: Caddy passwords. Keep private.\nSITE_USER=client\nSITE_PASS=%s\nINBOX_USER=inbox\nINBOX_PASS=%s\n' "$(gen)" "$(gen)" > "$LOGINS"
fi
# shellcheck disable=SC1090
source "$LOGINS"
SITE_HASH="$(caddy hash-password --plaintext "$SITE_PASS")"
INBOX_HASH="$(caddy hash-password --plaintext "$INBOX_PASS")"
sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
$HOST {
	encode gzip
	handle /inbox* {
		basic_auth {
			$INBOX_USER $INBOX_HASH
		}
		reverse_proxy 127.0.0.1:8025
	}
	handle {
		basic_auth {
			$SITE_USER $SITE_HASH
		}
		reverse_proxy 127.0.0.1:3000
	}
}
EOF
sudo systemctl reload caddy || sudo systemctl restart caddy

step "Start the database and the inbox"
pm2 startOrRestart deploy/demo/ecosystem.config.cjs --only vittora-mailpit,vittora-db
DB_PORT="$(grep '^DB_PORT=' .env | cut -d= -f2)"
for _ in $(seq 1 90); do (echo >"/dev/tcp/127.0.0.1/$DB_PORT") 2>/dev/null && break; sleep 2; done
sleep 5

step "Fake data"
[ -f .dev/seed-credentials.md ] || pnpm seed

step "Start the API and the web app"
pm2 startOrRestart deploy/demo/ecosystem.config.cjs --only vittora-api,vittora-web
for _ in $(seq 1 60); do curl -fs http://127.0.0.1:4000/readyz >/dev/null && curl -fs -o /dev/null http://127.0.0.1:3000/signin && break; sleep 2; done
pm2 save
sudo env PATH="$PATH" "$(command -v pm2)" startup systemd -u "$USER" --hp "$HOME" >/dev/null

curl -fs http://127.0.0.1:4000/readyz >/dev/null || { pm2 logs --lines 50 --nostream; echo "The API did not start."; exit 1; }
cat <<EOF

Done. Demo: https://$HOST   Test inbox: https://$HOST/inbox/
Site and inbox passwords: $LOGINS
App logins (fake accounts): $APP_DIR/.dev/seed-credentials.md
EOF
