#!/usr/bin/env bash
# Project Zomboid Control - server installer (Debian/Ubuntu and other systemd distros).
# Run as root:  sudo ./pz-control-server-installer.sh [options]
set -euo pipefail

APP_DIR=/opt/pz-control
CONF_DIR=/etc/pz-control
ENV_FILE=$CONF_DIR/pz-control.env
DATA_DIR=/var/lib/pz-control
UNIT=/etc/systemd/system/pz-control.service
SUDOERS=/etc/sudoers.d/pz-control

SRC_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

PZ_USER=""; PZ_DIR=""; SERVER_NAME=""; SERVICE=""; BIND=""; PORT=""
RCON_HOST=127.0.0.1; RCON_PORT=""; RCON_PASS=""; ADMIN_PASS=""
INTERACTIVE=1; UNINSTALL=0; PURGE=0; INSTALL_NODE=0; HTTPS=0; HTTPS_ADDR=""

usage() {
  cat <<'EOF'
Options (anything omitted is asked interactively, or defaulted with --yes):
  --user NAME            Linux user that runs the panel (owner of the Zomboid files)
  --pz-dir PATH          Zomboid "Server" folder (default: ~user/Zomboid/Server)
  --server-name NAME     Server name = ini prefix, e.g. servertest
  --service NAME         systemd unit of the Zomboid server (default: project-zomboid)
  --bind ADDRESS         Address to listen on (use your VPN/LAN address; default: detected)
  --port PORT            Panel port (default: 8080)
  --https [ADDRESS]      Serve the panel over HTTPS on port 443 through Caddy (installed with apt).
                         ADDRESS is a domain (Let's Encrypt) or an IP/LAN name (private certificate).
                         The panel itself then listens on 127.0.0.1 only.
  --rcon-host HOST       RCON host (default: 127.0.0.1)
  --rcon-port PORT       RCON port (default: read from the .ini, else 27015)
  --rcon-password PASS   RCON password (default: read from the .ini)
  --admin-password PASS  Panel password, 12+ chars (default: generated and shown once)
  --install-node         Install Node.js 20 via NodeSource if missing/too old
  --yes                  Non-interactive; accept defaults
  --uninstall [--purge]  Remove the service (--purge also deletes config and data)
EOF
}

die() { echo "ERROR: $*" >&2; exit 1; }
info() { echo "==> $*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --user) PZ_USER=$2; shift 2;;
    --pz-dir) PZ_DIR=$2; shift 2;;
    --server-name) SERVER_NAME=$2; shift 2;;
    --service) SERVICE=$2; shift 2;;
    --bind) BIND=$2; shift 2;;
    --port) PORT=$2; shift 2;;
    --https) HTTPS=1; if [ $# -gt 1 ] && [[ $2 != -* ]]; then HTTPS_ADDR=$2; shift 2; else shift; fi;;
    --rcon-host) RCON_HOST=$2; shift 2;;
    --rcon-port) RCON_PORT=$2; shift 2;;
    --rcon-password) RCON_PASS=$2; shift 2;;
    --admin-password) ADMIN_PASS=$2; shift 2;;
    --install-node) INSTALL_NODE=1; shift;;
    --yes|-y) INTERACTIVE=0; shift;;
    --uninstall) UNINSTALL=1; shift;;
    --purge) PURGE=1; shift;;
    -h|--help) usage; exit 0;;
    *) usage; die "Unknown option: $1";;
  esac
done
[ -t 0 ] || INTERACTIVE=0

[ "$(id -u)" -eq 0 ] || die "Run as root (use sudo)."
command -v systemctl >/dev/null || die "systemd is required."

if [ "$UNINSTALL" -eq 1 ]; then
  info "Removing Project Zomboid Control"
  systemctl disable --now pz-control 2>/dev/null || true
  rm -f "$UNIT" "$SUDOERS"
  if [ -f /etc/caddy/pz-control.caddy ]; then
    rm -f /etc/caddy/pz-control.caddy
    sed -i '\|import /etc/caddy/pz-control.caddy|d' /etc/caddy/Caddyfile 2>/dev/null || true
    systemctl reload caddy 2>/dev/null || true
  fi
  systemctl daemon-reload
  rm -rf "$APP_DIR"
  if [ "$PURGE" -eq 1 ]; then rm -rf "$CONF_DIR" "$DATA_DIR"; info "Config and data deleted."; else info "Kept $CONF_DIR and $DATA_DIR (use --purge to delete)."; fi
  exit 0
fi

ask() { # ask VAR "Prompt" default
  local var=$1 prompt=$2 default=$3 reply=""
  if [ -n "${!var}" ]; then return; fi
  if [ "$INTERACTIVE" -eq 1 ]; then read -r -p "$prompt [$default]: " reply || true; fi
  printf -v "$var" '%s' "${reply:-$default}"
}

# ---- Node.js
node_ok() { command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]; }
if ! node_ok; then
  if [ "$INSTALL_NODE" -eq 1 ]; then
    info "Installing Node.js 20 from NodeSource"
    command -v curl >/dev/null || { apt-get update -y && apt-get install -y curl ca-certificates; }
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  else
    die "Node.js 20 or newer is required. Install it, or re-run with --install-node."
  fi
fi
NODE=$(command -v node)
info "Using Node.js $("$NODE" -v) at $NODE"

# ---- Questions
DEFAULT_USER=pzuser; id pzuser >/dev/null 2>&1 || DEFAULT_USER=${SUDO_USER:-root}
ask PZ_USER "User that runs the Zomboid server" "$DEFAULT_USER"
id "$PZ_USER" >/dev/null 2>&1 || die "User '$PZ_USER' does not exist."
PZ_HOME=$(getent passwd "$PZ_USER" | cut -d: -f6)
ask PZ_DIR "Zomboid Server config folder" "$PZ_HOME/Zomboid/Server"
[ -d "$PZ_DIR" ] || die "Folder not found: $PZ_DIR"

FIRST_INI=$(find "$PZ_DIR" -maxdepth 1 -name '*.ini' -printf '%f\n' 2>/dev/null | head -n1 | sed 's/\.ini$//')
ask SERVER_NAME "Server name (ini file prefix)" "${FIRST_INI:-servertest}"
ask SERVICE "systemd service of the Zomboid server" "project-zomboid"

DETECTED_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
ask BIND "Address for the panel to listen on (VPN/LAN IP recommended)" "${DETECTED_IP:-127.0.0.1}"
ask PORT "Panel port" "8080"
if [ "$HTTPS" -eq 1 ]; then
  HTTPS_ADDR=${HTTPS_ADDR:-${DETECTED_IP:-}}
  [[ $HTTPS_ADDR =~ ^[A-Za-z0-9.:-]+$ ]] || die "Invalid --https address."
  BIND=127.0.0.1
fi

INI="$PZ_DIR/$SERVER_NAME.ini"
ini_value() { [ -f "$INI" ] && grep -E "^$1=" "$INI" | head -n1 | cut -d= -f2- | tr -d '\r' || true; }
[ -n "$RCON_PORT" ] || RCON_PORT=$(ini_value RCONPort)
[ -n "$RCON_PASS" ] || RCON_PASS=$(ini_value RCONPassword)
ask RCON_PORT "RCON port" "27015"
if [ -z "$RCON_PASS" ] && [ "$INTERACTIVE" -eq 1 ]; then read -r -s -p "RCON password (from $SERVER_NAME.ini): " RCON_PASS; echo; fi
[ -n "$RCON_PASS" ] || echo "WARNING: RCON password is empty - the console/players features will be disabled until you set RCON_PASSWORD in $ENV_FILE."

GENERATED_PASS=0
if [ -z "$ADMIN_PASS" ]; then ADMIN_PASS=$(head -c 64 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20); GENERATED_PASS=1; fi

[[ $SERVICE =~ ^[A-Za-z0-9_.@-]+$ ]] || die "Invalid service name."
[[ $SERVER_NAME =~ ^[A-Za-z0-9_.-]+$ ]] || die "Invalid server name."
[[ $PORT =~ ^[0-9]+$ && $PORT -ge 1 && $PORT -le 65535 ]] || die "Invalid port."
[[ $RCON_PORT =~ ^[0-9]+$ && $RCON_PORT -ge 1 && $RCON_PORT -le 65535 ]] || die "Invalid RCON port."
[ "${#ADMIN_PASS}" -ge 12 ] || die "Admin password must be at least 12 characters."
case "$RCON_PASS$ADMIN_PASS$BIND$PZ_DIR" in *$'\n'*) die "Values must not contain newlines.";; esac

# ---- Install files
info "Installing application to $APP_DIR"
mkdir -p "$APP_DIR"
for item in src public package.json package-lock.json node_modules .env.example; do
  [ -e "$SRC_DIR/$item" ] || continue
  rm -rf "${APP_DIR:?}/$item"
  cp -a "$SRC_DIR/$item" "$APP_DIR/$item"
done
mkdir -p "$APP_DIR/installer" && cp -a "$SRC_DIR/installer/setup.sh" "$APP_DIR/installer/setup.sh"
chown -R root:root "$APP_DIR"
chmod -R go-w "$APP_DIR"

mkdir -p "$DATA_DIR" && chown "$PZ_USER" "$DATA_DIR" && chmod 700 "$DATA_DIR"

# ---- Environment file (kept on upgrades)
quote() { local v=${1//\\/\\\\}; v=${v//\"/\\\"}; printf '"%s"' "$v"; }
mkdir -p "$CONF_DIR"; chmod 755 "$CONF_DIR"
if [ -f "$ENV_FILE" ]; then
  info "Keeping existing $ENV_FILE (upgrade). Admin password unchanged."
  GENERATED_PASS=0
else
  info "Writing $ENV_FILE"
  umask 077
  cat > "$ENV_FILE" <<EOF
PZ_ADMIN_PASSWORD=$(quote "$ADMIN_PASS")
HOST=$BIND
PORT=$PORT
PZ_DATA_DIR=$DATA_DIR
PZ_SERVER_DIR=$(quote "$PZ_DIR")
PZ_INI_FILE=$SERVER_NAME.ini
PZ_SANDBOX_FILE=${SERVER_NAME}_SandboxVars.lua
PZ_SPAWN_REGIONS_FILE=${SERVER_NAME}_spawnregions.lua
PZ_SPAWN_POINTS_FILE=${SERVER_NAME}_spawnpoints.lua
PZ_SERVICE=$SERVICE
RCON_HOST=$RCON_HOST
RCON_PORT=$RCON_PORT
RCON_PASSWORD=$(quote "$RCON_PASS")
SYSTEMCTL_PREFIX=$([ "$PZ_USER" = root ] && echo "" || echo sudo)
EOF
  chown root:root "$ENV_FILE"; chmod 600 "$ENV_FILE"
fi

set_env() { # set_env KEY VALUE: replace or append in the env file
  if grep -q "^$1=" "$ENV_FILE"; then sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"; else echo "$1=$2" >> "$ENV_FILE"; fi
}
if [ "$HTTPS" -eq 1 ]; then
  set_env HOST 127.0.0.1
  set_env TRUST_PROXY 1
  PORT=$(grep -E '^PORT=' "$ENV_FILE" | head -n1 | cut -d= -f2)
  BIND=127.0.0.1
fi

# ---- sudoers (narrow rule so the panel can control exactly one service)
if [ "$PZ_USER" != root ]; then
  SYSTEMCTL=$(command -v systemctl); JOURNALCTL=$(command -v journalctl)
  info "Writing $SUDOERS"
  TMP=$(mktemp)
  cat > "$TMP" <<EOF
$PZ_USER ALL=(root) NOPASSWD: $SYSTEMCTL start $SERVICE, $SYSTEMCTL stop $SERVICE, $SYSTEMCTL restart $SERVICE, $SYSTEMCTL is-active $SERVICE, $JOURNALCTL -u $SERVICE -n 250 --no-pager -o short-iso
EOF
  if command -v visudo >/dev/null && ! visudo -cf "$TMP" >/dev/null; then rm -f "$TMP"; die "Generated sudoers rule failed validation."; fi
  install -m 0440 -o root -g root "$TMP" "$SUDOERS"; rm -f "$TMP"
fi

# ---- systemd unit
info "Writing $UNIT"
cat > "$UNIT" <<EOF
[Unit]
Description=Project Zomboid Control (RCON, metrics and admin panel)
After=network.target

[Service]
Type=simple
User=$PZ_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE $APP_DIR/src/index.js
Restart=on-failure
RestartSec=3
Environment=NODE_ENV=production
PrivateTmp=true
ProtectSystem=full
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictNamespaces=true
RestrictRealtime=true
LockPersonality=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable pz-control >/dev/null
systemctl restart pz-control

CADDY_ROOT=""
if [ "$HTTPS" -eq 1 ]; then
  info "Setting up HTTPS with Caddy for $HTTPS_ADDR"
  command -v caddy >/dev/null || { apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq caddy >/dev/null; } || die "Could not install Caddy (apt)."
  TLS_LINE=""
  if [[ $HTTPS_ADDR =~ ^[0-9.]+$ || $HTTPS_ADDR == *:* || $HTTPS_ADDR != *.* || $HTTPS_ADDR =~ \.(lan|local|home|internal|arpa)$ ]]; then
    TLS_LINE="  tls internal"; CADDY_ROOT=/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt
  fi
  mkdir -p /etc/caddy
  cat > /etc/caddy/pz-control.caddy <<EOF
$HTTPS_ADDR {
$TLS_LINE
  encode gzip
  reverse_proxy 127.0.0.1:$PORT
}
EOF
  touch /etc/caddy/Caddyfile
  grep -qF "import /etc/caddy/pz-control.caddy" /etc/caddy/Caddyfile || echo "import /etc/caddy/pz-control.caddy" >> /etc/caddy/Caddyfile
  caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 || die "Caddy rejected the generated configuration."
  systemctl enable caddy >/dev/null 2>&1 || true
  systemctl restart caddy
  sleep 2
  # Public root certificate, copied so the panel can offer it for download to new clients.
  if [ -n "$CADDY_ROOT" ]; then
    for _ in 1 2 3 4 5 6 7 8 9 10; do [ -f "$CADDY_ROOT" ] || { curl -sk -o /dev/null "https://$HTTPS_ADDR/" || true; sleep 1; }; done
    if [ -f "$CADDY_ROOT" ]; then install -o "$PZ_USER" -m 644 "$CADDY_ROOT" "$DATA_DIR/root.crt"; fi
  fi
  [ -z "$CADDY_ROOT" ] || [ -f "$CADDY_ROOT" ] || CADDY_ROOT="(created on first connection) $CADDY_ROOT"
fi

# ---- Verify
HEALTH_HOST=$BIND; [ "$BIND" = 0.0.0.0 ] && HEALTH_HOST=127.0.0.1
sleep 1
OK=0
for _ in 1 2 3 4 5 6 7 8; do
  if "$NODE" -e "fetch('http://$HEALTH_HOST:$PORT/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then OK=1; break; fi
  sleep 1
done
if [ "$OK" -ne 1 ]; then
  journalctl -u pz-control -n 20 --no-pager || true
  die "Service did not become healthy. See the log above."
fi

echo
info "Project Zomboid Control is running."
SHOW_HOST=$HEALTH_HOST; [ "$BIND" = 0.0.0.0 ] && SHOW_HOST=${DETECTED_IP:-$HEALTH_HOST}
if [ "$HTTPS" -eq 1 ]; then
  echo "    URL:   https://$HTTPS_ADDR   (panel itself listens on 127.0.0.1:$PORT only)"
  [ -n "${CADDY_ROOT:-}" ] && echo "    Private certificate: trust $CADDY_ROOT on each computer that connects (copy it from the server)."
else
  echo "    URL:   http://$SHOW_HOST:$PORT   (use the desktop client, or any browser)"
fi
if [ "$GENERATED_PASS" -eq 1 ]; then echo "    Admin password (shown once, stored in $ENV_FILE): $ADMIN_PASS"; fi
echo "    Config: $ENV_FILE   Logs: journalctl -u pz-control -f"
[ "$BIND" = 0.0.0.0 ] && echo "    WARNING: listening on all interfaces - restrict port $PORT to your VPN/LAN with a firewall."
[ "$HTTPS" -eq 1 ] || echo "    RCON and this panel are not encrypted; keep them on a VPN or trusted LAN, or re-run with --https."
exit 0
