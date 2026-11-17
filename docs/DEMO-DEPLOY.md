# Demo server for client testing

A free test link for a client (D-030): one Oracle Cloud "Always Free" server in India runs the whole
portal. No AWS, nothing built on AWS.

> **Fake data only.** No real names, phone numbers, PAN, Aadhaar or documents. Real customer data needs
> the production setup after Part 8, not this server.

What runs on the server, all on `127.0.0.1` except Caddy:

| Piece | What it does |
|---|---|
| Caddy | HTTPS certificate, and a password in front of the whole site |
| Web app | `next start` on port 3000 |
| API | `DEPLOY_MODE=demo` on port 4000 |
| Postgres 16 | the same database as `pnpm db`, kept in `~/vittora/.dev/pg` |
| Mailpit | test inbox at `/inbox/` with its own password; every email and text lands here, nothing is really sent |

`DEPLOY_MODE=demo` makes the API refuse to start unless the dev inbox is off, the site is HTTPS, the API
is on loopback and mail goes to the test inbox on the same server. Cookies are secure and host-only.

---

## 1. Create the Oracle Cloud account (you, once)

1. Sign up at **cloud.oracle.com**. Oracle asks for a card to check you're a real person. Always Free
   resources aren't charged.
2. **Home region: India West (Mumbai) or India South (Hyderabad).** Free servers only exist in your home
   region, and it can't be changed later.

## 2. Create the server

In the Oracle console, go to **Compute → Instances → Create instance**:

| Setting | Choose |
|---|---|
| Image | Canonical **Ubuntu 24.04** |
| Shape | **Ampere → VM.Standard.A1.Flex**, 2 OCPUs, 12 GB memory (the free limit is 4 OCPUs and 24 GB) |
| Networking | Create a new virtual cloud network with a **public subnet**; **assign a public IPv4 address** |
| SSH keys | **Generate a key pair** and download the private key |

If you see **"Out of capacity"**, try another availability domain, fewer OCPUs, or try again later.
Note the server's **public IP address**.

## 3. Open ports 80 and 443 in Oracle's firewall

**Networking → Virtual cloud networks →** your network **→** its public subnet **→ Default security
list → Add ingress rules**. Add two rules, both with source CIDR `0.0.0.0/0` and protocol TCP: one for
destination port **80**, one for **443**. (The setup script opens the same ports on the server itself.)

## 4. Get a free web address

1. Sign in at **duckdns.org** and create a subdomain, for example `vittora-demo` →
   `vittora-demo.duckdns.org`.
2. Set its IP to the server's public IP and click **update ip**.

## 5. Run the setup script on the server

From your Mac, connect to the server (replace the key path and IP):

```bash
chmod 600 ~/Downloads/ssh-key.key
```

```bash
ssh -i ~/Downloads/ssh-key.key ubuntu@YOUR.SERVER.IP
```

On the server, download and run the script. Use the branch that has `deploy/demo/`: `main` once it's merged.

```bash
curl -fsSL https://raw.githubusercontent.com/Chainpilot1528/Finetech/main/deploy/demo/setup-server.sh -o setup-server.sh
```

```bash
bash setup-server.sh vittora-demo.duckdns.org main
```

It takes about 10 minutes. It installs Node 22, pm2, Caddy and Mailpit, builds the app, creates fresh
secrets and fake accounts, and makes everything restart if the server reboots. It's safe to run again.

## 6. Find the passwords (on the server)

```bash
cat ~/vittora-demo-passwords.env
```

```bash
cat ~/vittora/.dev/seed-credentials.md
```

- The first file has the **site** password (for the client) and the **inbox** password.
- The second has the **app accounts**: fake partner users and staff users, made fresh on this server.
  Staff sign in at `/ops/signin` and need an authenticator app on first sign-in.

## 7. What to send the client

- The link: `https://vittora-demo.duckdns.org`
- The site username and password
- One or two app accounts from `seed-credentials.md`, for example a partner admin and an executive

Sign-in links, password resets and the customer consent code all go to the **test inbox**
(`https://…/inbox/`). Either give the client the inbox password too, or read codes from it for them.
Everyone with the inbox password can see every message in it.

Send passwords separately from the link, for example the link by email and passwords by phone.

---

## Everyday tasks (on the server)

**Update to the latest code on the branch:**

```bash
bash ~/vittora/deploy/demo/update.sh
```

**See what's running, and the logs:**

```bash
pm2 status
```

```bash
pm2 logs vittora-api --lines 100
```

```bash
sudo journalctl -u caddy -n 50
```

**New passwords for the fake app accounts** (old ones stop working):

```bash
cd ~/vittora && pnpm seed
```

**Wipe all demo data and start again:**

```bash
cd ~/vittora && pm2 stop all && rm -rf .dev/pg .dev/storage .dev/seed-credentials.* && bash deploy/demo/setup-server.sh vittora-demo.duckdns.org main
```

## Things to know

- **Oracle may reclaim an idle free server** if it barely uses CPU for 7 days. Keep a copy of anything
  you need; the data is fake and can be recreated with the setup script.
- **If the address stops working**, check the DuckDNS IP still matches the server's public IP.
- **Never** set `DEV_MAILBOX=true` or put real data on this server.
