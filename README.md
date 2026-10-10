# Project Zomboid Control

[![CI](https://github.com/Jojaslav/project-zomboid-RCON-WEBconsole/actions/workflows/ci.yml/badge.svg)](https://github.com/Jojaslav/project-zomboid-RCON-WEBconsole/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

A self-hosted admin panel and RCON controller for a **Project Zomboid dedicated server on Linux**, with a Windows desktop client and optional **two-factor authentication** (any TOTP authenticator app).

- **Server** – a small Node.js service that runs next to your Zomboid server. It keeps the RCON connection, shows players and host/Java metrics, edits `.ini` / Sandbox / spawn files (with automatic backups), starts/stops/restarts the Zomboid systemd service, shows logs, and serves the web UI.
- **Client** – a Windows app that remembers your servers and opens the panel in its own window. The same UI also works in any web browser, so the client is optional.

Your RCON password never leaves the server. The client and browser only need the panel address and the admin password.

## Contents

1. [Requirements](#requirements)
2. [Step 1 – Enable RCON on your Zomboid server](#step-1--enable-rcon-on-your-zomboid-server)
3. [Step 2 – Install the server](#step-2--install-the-server-linux)
4. [Step 3 – Install the client](#step-3--install-the-client-windows)
5. [Step 4 – Enable two-factor authentication](#step-4--enable-two-factor-authentication-recommended)
6. [Installer options](#installer-options)
7. [Configuration reference](#configuration-reference)
8. [Upgrade and uninstall](#upgrade-and-uninstall)
9. [Troubleshooting](#troubleshooting)
10. [Security notes](#security-notes)
11. [Hardening and HTTPS](#hardening-and-https)
12. [Build from source](#build-from-source)
13. [What has been tested](#what-has-been-tested)

## Requirements

**Server machine**
- Linux with **systemd** (tested on Debian 12; Ubuntu and other systemd distributions should work).
- Project Zomboid dedicated server running as a **systemd service** (for example `project-zomboid`), under a normal user (for example `pzuser`).
- **Node.js 20 or newer.** The installer can install it for you with `--install-node`.
- Root access (`sudo`).

**Client machine**
- Windows 10 or 11, 64-bit. Or just use any web browser.

**Network**
- The client must be able to reach the panel port (default `8080`) on the server. See [Security notes](#security-notes): use a VPN or trusted LAN, do not expose the panel to the internet.

## Step 1 – Enable RCON on your Zomboid server

The panel talks to the game through RCON. Edit your server's `.ini` (usually `~/Zomboid/Server/<servername>.ini`, for example `servertest.ini`) and set:

```ini
RCONPort=27015
RCONPassword=choose-a-strong-password
```

Then restart the Zomboid server. RCON only needs to listen locally; you do **not** need to open port 27015 in your firewall, because the panel runs on the same machine.

## Step 2 – Install the server (Linux)

1. Download `pz-control-server-installer.sh` from the [Releases](../../releases) page (or build it yourself, see [Build from source](#build-from-source)).
2. Copy it to your server, for example:

   ```bash
   scp pz-control-server-installer.sh you@your-server:~
   ```

3. Run it as root:

   ```bash
   sudo bash pz-control-server-installer.sh --install-node
   ```

   Leave out `--install-node` if Node.js 20+ is already installed.

4. Answer the questions. Press Enter to accept the default shown in brackets.

   | Question | What to enter |
   |---|---|
   | User that runs the Zomboid server | The Linux user that owns the Zomboid files, e.g. `pzuser` |
   | Zomboid Server config folder | Folder containing your `.ini`, e.g. `/home/pzuser/Zomboid/Server` |
   | Server name | The `.ini` file name without `.ini`, e.g. `servertest` |
   | systemd service of the Zomboid server | e.g. `project-zomboid` (check with `systemctl list-units | grep -i zomboid`) |
   | Address to listen on | Your VPN or LAN address (recommended). `0.0.0.0` listens on all interfaces. |
   | Panel port | `8080` unless that is taken |

   The RCON port and password are read from your `.ini` automatically.

5. At the end the installer prints the panel URL and a generated **admin password. It is shown only once**, so save it now. It is also stored in `/etc/pz-control/pz-control.env`, which only root can read.

6. Check that it is running:

   ```bash
   systemctl status pz-control
   curl http://127.0.0.1:8080/api/health     # replace the address if you bound to a specific IP
   ```

   You should see `{"ok":true,...}`.

7. Open `http://<server-address>:8080` in a browser and sign in with the admin password.

**Non-interactive example** (no questions asked):

```bash
sudo bash pz-control-server-installer.sh --yes --install-node \
  --user pzuser --server-name servertest --service project-zomboid \
  --bind 10.8.0.12 --port 8080
```

### What the installer does

| Item | Location |
|---|---|
| Application | `/opt/pz-control` |
| Config (root-only, mode 600) | `/etc/pz-control/pz-control.env` |
| Data (2FA file, state) | `/var/lib/pz-control` |
| systemd unit | `/etc/systemd/system/pz-control.service` (runs as your Zomboid user) |
| sudo rule | `/etc/sudoers.d/pz-control` – lets that user run **only** `start`, `stop`, `restart`, `is-active` on the Zomboid service and read its journal |

Dependencies are bundled in the installer, so `npm` is not needed on the server.

### Open the firewall port (if you use a firewall)

Allow the panel port **only from your VPN/LAN**, for example with ufw:

```bash
sudo ufw allow from 10.8.0.0/24 to any port 8080 proto tcp
```

## Step 3 – Install the client (Windows)

1. Download `pz-control-client-setup-<version>.exe` from the [Releases](../../releases) page (or build it, see below).
2. Run it. It installs per-user, with no administrator rights, and creates Start Menu and desktop shortcuts.
3. The installer is **not code-signed**, so Windows SmartScreen may warn you. Click **More info → Run anyway**.
4. Start **Project Zomboid Control**, type the server address as `host:port` (for example `10.8.0.12:8080`), and click **Connect**.
5. Sign in with the admin password (and your 2FA code, once enabled).

The client remembers addresses you have used. If the address is wrong or unreachable, it shows an error instead of loading.

## Step 4 – Enable two-factor authentication (recommended)

Works with any TOTP app: Google Authenticator, Microsoft Authenticator, Authy, 1Password, Bitwarden, Aegis, and others.

1. Sign in, open the **Security** tab, and click **Set up two-factor authentication**.
2. Scan the QR code with your app (or type the shown key in manually).
3. Enter the current 6-digit code and click **Verify and enable**.
4. **Save the 10 backup codes** that appear. Each works once and they are never shown again.

From then on, login asks for the password and then a 6-digit code (or a backup code).

- Disabling 2FA or generating new backup codes requires the password **and** a current code.
- Enabling or disabling 2FA signs out all other sessions.
- Wrong codes count toward the login lockout.
- A code can't be used twice.
- **Keep the server clock correct** (NTP). TOTP codes depend on the time.

### Lost your phone and your backup codes?

On the server:

```bash
sudo rm /var/lib/pz-control/2fa.json
sudo systemctl restart pz-control
```

2FA is now off; sign in with the password and set it up again.

## Multiple users

Besides the built-in `admin` account you can add more users. Open **Security → Users**:

1. Enter a username (3-32 characters: lowercase letters, digits, `.`, `-`, `_`) and a temporary password (12+ characters), then confirm with **your** password (and code).
2. Give the person the username and temporary password.
3. On their first sign-in they are asked to scan a QR code with their own authenticator app and verify a code, and receive their own backup codes. Two-factor is mandatory for added users and cannot be turned off.

Rules:

- **Every user has the same full access as admin**, including adding, resetting and deleting users. Only add people you trust with the server.
- Each user has their own password, authenticator secret and backup codes. Users are stored in `/var/lib/pz-control/users.json` (mode 600, passwords hashed with scrypt).
- **Reset** (for a user who lost their phone and backup codes) sets a new temporary password, removes their authenticator and signs them out; they enrol again at next sign-in. **Delete** removes the user and signs them out.
- Users change their own password under **Security → Change my password**. The built-in `admin` password is changed in `/etc/pz-control/pz-control.env`.
- Adding, resetting and deleting users, and changing a password, require the acting user's password and a current code.
- If every user is locked out, use the admin account (its password is in the env file) and reset them, or delete `/var/lib/pz-control/users.json` to remove all added users.
### Trusting the certificate on a new computer

With `--https` on a private address, each new computer must trust the server's root certificate once. Sign in (accept the browser warning for this first visit), open **Security → Certificate for new computers**, and download it. The installer places a copy in `/var/lib/pz-control/root.crt`; on servers installed before this feature, re-run the installer to create it.

## Installer options

```text
--user NAME            Linux user that runs the panel (owner of the Zomboid files)
--pz-dir PATH          Zomboid "Server" folder (default: ~user/Zomboid/Server)
--server-name NAME     Server name = .ini prefix, e.g. servertest
--service NAME         systemd unit of the Zomboid server (default: project-zomboid)
--bind ADDRESS         Address to listen on (default: detected)
--port PORT            Panel port (default: 8080)
--https [ADDRESS]      Serve over HTTPS on port 443 via Caddy; panel listens on 127.0.0.1 only
--rcon-host HOST       RCON host (default: 127.0.0.1) HOST       RCON host (default: 127.0.0.1)
--rcon-port PORT       RCON port (default: read from the .ini, else 27015)
--rcon-password PASS   RCON password (default: read from the .ini)
--admin-password PASS  Panel password, 12+ characters (default: generated and shown once)
--install-node         Install Node.js 20 from NodeSource if missing or too old
--yes                  Non-interactive; accept defaults
--uninstall [--purge]  Remove the service (--purge also deletes config and data)
```

## Configuration reference

Settings live in `/etc/pz-control/pz-control.env`. After editing, run `sudo systemctl restart pz-control`.

| Variable | Meaning |
|---|---|
| `PZ_ADMIN_PASSWORD` | Panel password (12+ characters) |
| `HOST` / `PORT` | Address and port the panel listens on |
| `TRUST_PROXY` | `1` when a reverse proxy on the same machine terminates HTTPS (set by `--https`) |
| `PZ_DATA_DIR` | Where panel state, `2fa.json` and `users.json` live |
| `PZ_SERVER_DIR` | Zomboid `Server` folder |
| `PZ_INI_FILE`, `PZ_SANDBOX_FILE`, `PZ_SPAWN_REGIONS_FILE`, `PZ_SPAWN_POINTS_FILE` | File names inside that folder |
| `PZ_SERVICE` | systemd unit of the Zomboid server |
| `RCON_HOST`, `RCON_PORT`, `RCON_PASSWORD` | RCON connection |
| `SYSTEMCTL_PREFIX` | `sudo` when the narrow sudoers rule is installed (the installer sets this) |

To change the admin password, edit `PZ_ADMIN_PASSWORD` and restart the service.

## Upgrade and uninstall

**Upgrade:** run the new installer again. Code is replaced, your config and 2FA setup are kept.

```bash
sudo bash pz-control-server-installer.sh --yes --user pzuser
```

**Uninstall:**

```bash
sudo bash pz-control-server-installer.sh --uninstall          # keeps config and data
sudo bash pz-control-server-installer.sh --uninstall --purge  # deletes everything
```

Uninstalling never touches your Zomboid server or its files. The Windows client is removed from *Settings → Apps*.

## Troubleshooting

| Symptom | Check |
|---|---|
| Installer says Node.js 20+ is required | Re-run with `--install-node`, or install Node.js 20+ yourself |
| `Folder not found` | Pass the correct `--pz-dir` (the folder that contains `<name>.ini`) |
| Can't reach the panel | `systemctl status pz-control`, `journalctl -u pz-control -f`, the bind address and port, and your firewall |
| Dashboard says RCON is not configured / connection refused | RCON is enabled in the `.ini`, the Zomboid server was restarted, and `RCON_PORT` / `RCON_PASSWORD` in `/etc/pz-control/pz-control.env` match |
| Service buttons fail | The `PZ_SERVICE` name is correct (`systemctl status <name>`), and `/etc/sudoers.d/pz-control` exists |
| "Project Zomboid process is not running" in metrics | The game server is stopped, or `PZ_SERVICE` is wrong |
| 2FA code always rejected | Fix the server clock (`timedatectl`), and on the phone enable automatic time |
| Locked out (too many failures) | Wait 5 minutes |
| Windows warns about the installer | It is unsigned; use **More info → Run anyway** |

## Security notes

- By default the panel and RCON use **plain HTTP**. Either run the panel on a **VPN or trusted LAN**, or install with `--https` (see [Hardening and HTTPS](#hardening-and-https)). Don't forward the plain-HTTP port to the internet.
- Login is rate-limited: 5 failures lock that IP out for 5 minutes. Sessions last 12 hours.
- The admin password must be at least 12 characters.
- The 2FA secret is stored in `/var/lib/pz-control/2fa.json` (mode 600, owned by the service user). Anyone with root on the server can read it.
- The service runs as your Zomboid user, with sudo allowed for one service only, and is sandboxed with systemd (read-only system directories, no kernel tuning, restricted namespaces).

## Hardening and HTTPS

### Encrypt the panel (HTTPS)

Run the installer with `--https`. It installs [Caddy](https://caddyserver.com/) from your distribution's packages, puts it in front of the panel on port 443, and makes the panel listen on `127.0.0.1` only. Session cookies become `Secure` and HSTS is sent.

```bash
# LAN or VPN address (Caddy creates a private certificate)
sudo bash pz-control-server-installer.sh --yes --user pzuser --https 192.168.1.50

# Public domain pointing at the server (free Let's Encrypt certificate; ports 80 and 443 must be reachable)
sudo bash pz-control-server-installer.sh --yes --user pzuser --https zomboid.example.com
```

With a **private** certificate, each computer that connects must trust it once. Copy `/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt` from the server, then on Windows run `certutil -user -addstore Root root.crt`. Then enter `https://<address>` in the client (or a browser). With a Let's Encrypt domain nothing extra is needed.

RCON stays plain, but it never leaves the machine: the panel talks to it on `127.0.0.1`, and the client reaches RCON through the panel. Keep port 27015 closed in your firewall.

### Firewall (ufw)

```bash
sudo apt install ufw
sudo ufw default deny incoming
sudo ufw allow 22/tcp                 # SSH
sudo ufw allow 443/tcp                # panel over HTTPS (not needed without --https)
sudo ufw allow 16261:16272/udp        # game traffic: adjust to your DefaultPort / UDPPort
sudo ufw allow 16261:16272/tcp
sudo ufw enable
```

### SSH

1. On your PC: `ssh-keygen -t ed25519`, then `ssh-copy-id user@server` (or append the `.pub` file to `~/.ssh/authorized_keys`).
2. Check that `ssh -o PasswordAuthentication=no user@server` works **before** continuing.
3. Create `/etc/ssh/sshd_config.d/00-hardening.conf`:

   ```text
   PasswordAuthentication no
   KbdInteractiveAuthentication no
   PermitRootLogin no
   MaxAuthTries 3
   ```

4. `sudo sshd -t && sudo systemctl restart ssh`, and keep your current session open until a new login works.
5. Protect the private key with a passphrase (`ssh-keygen -p -f ~/.ssh/id_ed25519`).

### Brute-force protection and updates

```bash
sudo apt install fail2ban unattended-upgrades
sudo systemctl enable --now fail2ban
echo -e 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";' | sudo tee /etc/apt/apt.conf.d/20auto-upgrades
```

## Build from source

Requires Node.js 20+ (the client build also needs Windows).

```powershell
npm --prefix server install
npm --prefix client install
npm test                    # server and client tests
npm run build:server        # -> dist/pz-control-server-installer.sh
npm run build:client        # -> dist/client/pz-control-client-setup-<version>.exe
```

To run the server without installing it, copy `server/.env.example` to `server/.env`, fill it in, and run `npm --prefix server start`.

## What has been tested

Tested:
- Automated tests (server, RCON, auth, 2FA, client address storage).
- The server installer on a clean **Debian 12** VM with systemd: install, panel login, service control, config save with backup, logs, RCON, 2FA enrolment and login, upgrade, uninstall and purge.
- The web UI in a browser, including the 2FA QR code, backup codes and the two-step login.
- The packaged Windows client connecting to a server and loading the UI.

- The server installer on a **real Debian 13 host running Project Zomboid (build 42)**: install, login, live RCON, service status, config read, and Java CPU/memory/uptime metrics. Testing there fixed two bugs: build 42's `ProjectZomboid64` launcher wasn't detected, and uptime was wrong in containers.

Not tested yet:
- JVM heap is not reported.
- Ubuntu and other distributions.
- The Windows client against a Linux server over a real network on other setups.

Please open an issue if something doesn't work on your setup.
