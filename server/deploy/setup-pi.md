# One-time setup: Pocket Agent on a Raspberry Pi 3B+

Target: 64-bit Raspberry Pi OS (Bookworm or later), reachable over Tailscale.

## 1. Base packages

```bash
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y git build-essential
```

## 2. Node 22 (arm64) via nvm

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install 22
node --version   # confirm arm64, v22+ (this repo requires node >=22 — v22.x or newer both work)
corepack enable
```

## 3. Tailscale

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Note the assigned name — it becomes `<pi-name>.<tailnet>.ts.net`.

Front the app with `tailscale serve` (real Let's Encrypt cert via the tailnet's cert store, satisfies iOS ATS with no exceptions):

```bash
sudo tailscale serve --bg https / http://127.0.0.1:3000
```

Verify: `curl https://<pi-name>.<tailnet>.ts.net/healthz` from another tailnet device.

(Later, `tailscale funnel 443 on` flips the same endpoint public — see §10 of the plan for the tradeoffs. Not the default posture.)

## 4. Create the service user and directories

```bash
sudo useradd --system --home /opt/pocket-agent --shell /usr/sbin/nologin pocket-agent
sudo mkdir -p /opt/pocket-agent
sudo chown -R pocket-agent:pocket-agent /opt/pocket-agent
```

`pocket-agent` has no login shell on purpose — it only ever runs the systemd service, never an interactive session.

Do **not** pre-create `/opt/pocket-agent/server` here. Step 5 symlinks `/opt/pocket-agent/server` to `repo/server` — if `server/` already exists as a real directory, `ln -s` drops the link *inside* it (`/opt/pocket-agent/server/server`) instead of replacing it, and the systemd unit's `WorkingDirectory` ends up pointing at an empty directory. `data/` gets created under `repo/server/` in step 5 instead.

### 4a. Let your admin user deploy as `pocket-agent`

`deploy.sh` SSHes in as your own admin account (the one you log into the Pi with) and hops to `pocket-agent` via passwordless `sudo` for the repo-owned steps. Add a sudoers rule for that (replace `pi` with your actual admin username):

```bash
sudo visudo -f /etc/sudoers.d/pocket-agent-deploy
```

```
pi ALL=(pocket-agent) NOPASSWD: ALL
pi ALL=(root) NOPASSWD: /usr/bin/systemctl restart pocket-agent, /usr/bin/systemctl is-active --quiet pocket-agent, /usr/bin/journalctl -u pocket-agent -n 50 --no-pager
```

`pocket-agent` itself has no privileges beyond its own files, so letting your admin user act as it is a low-risk hop — the systemctl/journalctl grants are scoped to just the `pocket-agent` unit.

## 5. Deploy the code

From your laptop, over the tailnet (see `deploy.sh`), as your admin user:

```bash
./deploy/deploy.sh <pi-tailnet-name>
```

(`deploy.sh` defaults `DEPLOY_USER` to `pi` — set `DEPLOY_USER=<your-admin-username>` if it differs.)

Or, logged into the Pi itself (console or an SSH session already on the box), skip the SSH hop:

```bash
./deploy/deploy-local.sh
```

Same steps as `deploy.sh` minus the remote shell — still runs the repo-owned steps as `pocket-agent` via the sudoers rule from §4a.

Or manually on the Pi, as your admin user:

```bash
sudo -u pocket-agent git clone https://github.com/dsyang/pocketagent.git /opt/pocket-agent/repo
sudo -u pocket-agent mkdir -p /opt/pocket-agent/repo/server/data

sudo -u pocket-agent bash -c 'cd /opt/pocket-agent/repo/server && pnpm install --frozen-lockfile'
```

`pocket-agent` has no SSH key of its own, so clone over HTTPS (fine for this public repo) rather than the `git@github.com:...` SSH form.

The install will stop partway with `[ERR_PNPM_IGNORED_BUILDS]` — pnpm blocks the postinstall scripts for `better-sqlite3` (needs to compile its native SQLite bindings) and `esbuild` by default. Approve them once:

```bash
sudo -u pocket-agent bash -c 'cd /opt/pocket-agent/repo/server && pnpm approve-builds --all'
```

This compiles `better-sqlite3` from source via node-gyp — expect several minutes on a Pi 3B+, no prebuilt arm64 binary is fetched. (The `[WARN] The "pnpm" field in package.json is no longer read...` message alongside this is harmless noise from a newer pnpm relocating that setting; safe to ignore.)

Then build and finish:

```bash
sudo -u pocket-agent bash -c 'cd /opt/pocket-agent/repo/server && pnpm run build'
sudo -u pocket-agent bash -c 'cd /opt/pocket-agent/repo/server && pnpm prune --prod'
sudo ln -s /opt/pocket-agent/repo/server /opt/pocket-agent/server   # or copy, see deploy.sh
```

## 6. Secrets: `/opt/pocket-agent/server/.env`

```bash
sudo -u pocket-agent tee /opt/pocket-agent/server/.env <<'EOF'
DATABASE_PATH=/opt/pocket-agent/server/data/pocket-agent.db
HOST=127.0.0.1
PORT=3000
AUTH_TOKEN=<generate: openssl rand -hex 32>
OPENROUTER_API_KEY=<your OpenRouter key>
DEFAULT_MODEL=anthropic/claude-sonnet-5
# Optional: OpenRouter's provider.max_price routing ceiling, in USD per
# million completion tokens — requests route only to providers at or under
# this price. Not a per-run spend cap. Leave unset for no ceiling.
MAX_PRICE_USD=
# Optional: leave unset to disable push
APNS_TEAM_ID=
APNS_KEY_ID=
APNS_SIGNING_KEY=
APNS_TOPIC=
EOF
sudo chmod 600 /opt/pocket-agent/server/.env
```

`AUTH_TOKEN` is the *only* gate if Funnel is ever enabled — generate it long and random, paste it once into each client's Settings screen (Keychain/Keystore on mobile, `localStorage` for the web page).

For APNs: create a `.p8` auth key in the Apple Developer portal (Certificates, Identifiers & Profiles → Keys), note its Key ID and your Team ID, and paste the key's contents (including `-----BEGIN/END PRIVATE KEY-----` lines) as `APNS_SIGNING_KEY`.

## 7. Install and start the systemd unit

```bash
sudo cp /opt/pocket-agent/repo/server/deploy/pocket-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pocket-agent
sudo systemctl status pocket-agent
journalctl -u pocket-agent -f
```

## 8. Smoke test

From a laptop on the tailnet:

```bash
export POCKET_AGENT_URL=https://<pi-name>.<tailnet>.ts.net
export POCKET_AGENT_TOKEN=<the AUTH_TOKEN above>
pnpm --dir server chat new anthropic/claude-sonnet-5 "smoke test"
pnpm --dir server chat send <conversationId> "what's the weather like today"
```

Watch it search and stream. Ctrl-C mid-answer, then:

```bash
pnpm --dir server chat tail <conversationId>
```

...and confirm the finished answer replays. Then, to prove crash recovery:

```bash
sudo systemctl restart pocket-agent
```

mid-run, and confirm the run is reported `interrupted` on the next snapshot.
