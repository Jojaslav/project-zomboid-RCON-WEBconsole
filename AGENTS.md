# AGENTS.md

Guidance for AI coding agents working in this repository.

## What this project is

Project Zomboid Control: a Node.js service that runs next to a Project Zomboid dedicated server (Linux) and a Windows Electron client.

- **Server** (`server/`): Express app with RCON, host and Java metrics read from `/proc`, config editors with backups, systemd service control, live journal logs, TOTP two-factor authentication, and a static web UI.
- **Client** (`client/`): a small Electron app that stores server addresses and opens the server's web UI. It contains no panel logic.
- **Installers**: `server/installer/setup.sh` is bundled by `tools/build-server-installer.js` into `dist/pz-control-server-installer.sh`. The Windows installer is built with electron-builder.

## Layout

| Path | Purpose |
|---|---|
| `server/src/app.js` | Express routes, security headers, cookies, service readiness light |
| `server/src/auth.js` | Sessions, login rate limiting, 2FA challenges |
| `server/src/twofactor.js` | TOTP, backup codes, `2fa.json` storage |
| `server/src/rcon.js` | RCON client and reconnecting wrapper |
| `server/src/metrics.js` | `/proc` collector (Java CPU, RSS, uptime) |
| `server/src/system.js` | `ServiceControl` (systemctl/journalctl) and config file handling |
| `server/src/config.js` | Environment parsing and validation |
| `server/public/` | Web UI: `index.html`, `app.js`, `style.css` |
| `server/installer/` | `setup.sh` (the installer) and `stub.sh` (self-extracting header) |
| `client/` | Electron main/preload and the connect window |
| `tools/build-server-installer.js` | Builds the self-extracting server installer |

## Commands

Requires Node.js 20+. Run from the repository root.

```bash
npm --prefix server ci        # install server dependencies
npm --prefix client ci        # only needed to run or build the Windows client
npm test                      # server and client tests (node:test, no extra framework)
npm run build:server          # -> dist/pz-control-server-installer.sh
npm run build:client          # -> dist/client/pz-control-client-setup-<version>.exe (Windows only)
bash -n server/installer/setup.sh   # syntax-check the installer
```

To run the server locally, copy `server/.env.example` to `server/.env`, set `PZ_ADMIN_PASSWORD` (12+ characters), and run `npm --prefix server start`.

CI (`.github/workflows/ci.yml`) runs the tests, the `setup.sh` syntax check and the installer build. Pushing a `v*` tag runs `release.yml`, which builds both installers and attaches them to a GitHub Release.

## Conventions

- **Tests:** `node --test` with no quoted glob in `package.json` (a quoted glob fails on Node 20). Test files live in `server/test/` and `client/test/`. Add or update a test for any behaviour change in the server.
- **Line endings:** LF everywhere, enforced by `.gitattributes`. Shell scripts with CRLF break on Linux.
- **Dependencies:** keep the server dependency list small. The installer bundles `node_modules`, so the target machine needs no `npm`.
- **Web UI:** the Content-Security-Policy allows only same-origin scripts and styles. Do not add inline scripts, inline event handlers, inline styles or third-party CDNs.
- **Comments:** only where the reason is not obvious.
- **Client:** the client loads the server's UI, so UI changes need no client rebuild. Only changes under `client/` do.

## Security rules (do not weaken)

- **No secrets in the repo.** Never commit real passwords, RCON passwords, IP addresses, host names, keys or `.env` files. Use placeholders such as `192.168.1.50` in docs and examples.
- **Authentication:** every `/api/*` route except `/api/health`, `/api/session`, `/api/login` and `/api/login/2fa` must use `requireAuth`. Login failures are rate limited per IP, and the 2FA second step must stay rate limited.
- **Cookies:** `HttpOnly`, `SameSite=Strict`, and `Secure` whenever the request is HTTPS (behind the trusted proxy).
- **Command execution:** the server runs only fixed `systemctl` and `journalctl` commands through `ServiceControl`, with no shell. Never build commands from request input.
- **File access:** config files are limited to a fixed list of names inside `PZ_SERVER_DIR`. Keep the path checks and the backup-before-write behaviour.
- **sudoers coupling:** the installer writes a sudoers rule with **exact arguments** (start, stop, restart, is-active for one service, and `journalctl -u <service> -n 250 --no-pager -o short-iso`). If you change a command in `system.js`, change the rule in `setup.sh` in the same commit, or the panel breaks on installed servers. Installed servers need the upgraded installer re-run to pick up a new rule.
- **Proxy trust:** `TRUST_PROXY` only trusts loopback. Do not widen it.

## Zomboid and host quirks (learned on real servers)

- Build 42 runs the game process as `ProjectZomboid64`, not `java`. `metrics.js` accepts both.
- In some containers `/proc/uptime` is virtualised. Process uptime is computed from `btime` in `/proc/stat` plus the wall clock.
- The Zomboid journal can be quiet for days. The log view polls `/api/logs` every second, and the server shares one `journalctl` call per second. "SERVER STARTED" is detected from the last 250 journal lines, so it can be missing on a long-running server until the next restart.
- RCON listens on `127.0.0.1` only and must not be opened in a firewall. The panel talks to it locally.

## Installer notes (`server/installer/setup.sh`)

- Idempotent: re-running it upgrades the code and keeps `/etc/pz-control/pz-control.env` and the 2FA data.
- `--https [ADDRESS]` installs Caddy, puts the panel on `127.0.0.1`, sets `TRUST_PROXY=1`, and writes `/etc/caddy/pz-control.caddy`. `--uninstall` removes that file again.
- It must not restart or modify the Zomboid service.
- After editing it, run `bash -n`, rebuild with `npm run build:server`, and test on a disposable Linux machine or VM before releasing. Do not test against someone's production server.

## Before you finish a change

1. Run `npm test`.
2. If `setup.sh`, `tools/`, or anything bundled into the installer changed, run `npm run build:server`.
3. Update `README.md` if user-visible behaviour, options or configuration changed.
4. Check that no secret, IP address or personal path slipped into the diff.
