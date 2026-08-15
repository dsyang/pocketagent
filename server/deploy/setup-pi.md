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
node --version   # confirm v22.x, arm64
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
sudo mkdir -p /opt/pocket-agent/server/data
sudo chown -R pocket-agent:pocket-agent /opt/pocket-agent
```

## 5. Deploy the code

From your laptop, over the tailnet (see `deploy.sh`):

```bash
./deploy/deploy.sh <pi-tailnet-name>
```

Or manually on the Pi:

```bash
sudo -u pocket-agent git clone <this-repo-url> /opt/pocket-agent/repo
cd /opt/pocket-agent/repo/server
sudo -u pocket-agent pnpm install --prod
sudo -u pocket-agent pnpm run build
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
