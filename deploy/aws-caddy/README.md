# ArimaOps v2.0 — AWS EC2 + Caddy Automatic Wildcard HTTPS Deployment

Deploy ArimaOps v2.0 on an Ubuntu EC2 instance with automatic HTTPS TLS, WebAuthn Passkeys, and origin-isolated live preview subdomains:

- **HQ Control Plane:** `https://hq.<your-domain>` -> `127.0.0.1:7420`
- **Isolated Live Previews:** `https://preview-<project-slug>.<your-domain>` -> `127.0.0.1:7421`

## Architecture & Security Properties

1. **Loopback-Only Backend Ports:** `arima-hq` binds `:7420` and `:7421` strictly to `127.0.0.1`. UFW and the EC2 Security Group expose only `22`, `80`, and `443`.
2. **True Origin Isolation:** Preview sessions run on `https://preview-<slug>.<domain>` using an `HttpOnly; Secure; SameSite=Lax` cookie (`arima_preview_sid`) bound to `(project_id, target_id, hq_origin)`. Untrusted preview apps can never read `hq_sid`, replay cookies across projects, or call `https://hq.<domain>/api/*`.
3. **Passkeys & TOTP Ready:** Setting `HQ_PUBLIC_ORIGIN=https://hq.<domain>` and `HQ_TRUST_PROXY=true` automatically enables WebAuthn Passkeys and enforces `Secure` session cookies behind Caddy.

## Quick Start

1. **AWS EC2 & DNS Prerequisites:**
   - Launch an Ubuntu 22.04 or 24.04 EC2 instance (recommended: `t3.large` or `c7i.large` with 40 GB gp3 EBS).
   - Allow inbound TCP ports `22`, `80`, and `443` in the EC2 Security Group.
   - Create DNS `A` records pointing to your Elastic IP for:
     - `hq.<your-domain>`
     - `*.<your-domain>`

2. **Bootstrap the Host:**
   ```bash
   sudo ./setup-ec2.sh
   ```

3. **Configure Environment:**
   ```bash
   sudoedit /opt/arimaops/.env
   # Set ARIMA_DOMAIN, ACME_EMAIL, and a 32-byte ARIMA_GITHUB_WEBHOOK_SECRET
   ```

4. **Start the Stack:**
   ```bash
   cd /opt/arimaops
   sudo docker compose -f compose.aws.yaml --env-file .env up -d
   sudo docker logs arimaops-hq-v2 | grep "token="
   ```

5. **Optional DNS-01 Wildcard Certificate (Cloudflare / Route53):**
   - The default `Caddyfile` uses zero-plugin On-Demand TLS (each `preview-<slug>.<domain>` issues a cert automatically on first open, gated by `http://127.0.0.1:7421/__arima_preview/health`).
   - If you prefer a single `*.<domain>` wildcard cert via DNS-01, build Caddy with `xcaddy` including `github.com/caddy-dns/cloudflare` or `github.com/caddy-dns/route53`, set `CADDY_IMAGE` and your provider token in `.env`, and uncomment the `dns` block in `Caddyfile`.

6. **Connect Desktop & Android Clients:**
   - Open the unified ArimaOps client (`apps/client/`) on Linux, macOS, Windows, or Android and add `https://hq.<your-domain>`.

## Private mode: Tailscale only (no public ports)

For a team that does not want a public HQ, skip Caddy and the public DNS records entirely:

1. Close ports 80/443 in the EC2 Security Group; keep 22 only for your own IPs.
2. `docker compose -f compose.aws.yaml --env-file .env up -d arima-hq` with
   `HQ_PUBLIC_ORIGIN=https://<machine>.<tailnet>.ts.net` and, if another service holds the ports,
   `HQ_HOST_PORT=7520` in `.env`. Do not start `caddy`.
3. `sudo tailscale serve --bg --https=443 http://127.0.0.1:7520` (tailnet only; never `funnel`).
4. Passkeys bind to the HQ public origin, so they work on that tailnet name only.
5. Live previews need wildcard hostnames and are not available in this mode.

## Demo HQ

`compose.demo.yaml` runs a second, isolated HQ (own volume, fake data, loopback only) for trying the app:

```bash
docker compose -p arimaops-demo -f compose.demo.yaml --env-file .env up -d
sudo tailscale serve --bg --https=8443 http://127.0.0.1:7530
```

Set `DEMO_PUBLIC_ORIGIN=https://<machine>.<tailnet>.ts.net:8443` in `.env` first.

## Updating the server (CI deploy)

Every push to `main` that touches the server or UI runs `.github/workflows/hq-image.yml`, which publishes
`ghcr.io/sachindots/arimaops-v2:latest` (and a `sha-<commit>` tag). To update a host:

```bash
sudo /opt/arimaops/update.sh
```

It pulls the image, recreates the HQ (and the demo HQ if present), waits for `/api/health`, and prunes old
images. Set `ARIMA_HQ_IMAGE=ghcr.io/sachindots/arimaops-v2:latest` in `/opt/arimaops/.env` once. To roll back,
set it to an earlier `sha-<commit>` tag and run the script again. Data lives in Docker volumes and survives
updates; database migrations run automatically on start.
