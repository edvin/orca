#!/bin/bash
set -euo pipefail

# Orca Daemon Installer for Linux
# Usage: curl -fsSL https://orca-desktop.com/install-daemon.sh | sudo sh

VERSION="${ORCA_VERSION:-latest}"
REPO="edvin/orca"
INSTALL_DIR="/usr/local/bin"
CONFIG_DIR="/etc/orca"
SERVICE_FILE="/etc/systemd/system/orca-daemon.service"

echo "=== Orca Daemon Installer ==="
echo ""

# Check root
if [ "$(id -u)" -ne 0 ]; then
    echo "Error: This script must be run as root (use sudo)"
    exit 1
fi

# Detect architecture
ARCH=$(uname -m)
case "$ARCH" in
    x86_64) ARCH="x86_64" ;;
    aarch64|arm64) ARCH="aarch64" ;;
    *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

# Detect OS
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
if [ "$OS" != "linux" ]; then
    echo "This installer is for Linux only."
    exit 1
fi

# Check for Docker
if ! command -v docker &>/dev/null; then
    echo "Warning: Docker is not installed."
    echo "Install Docker first: curl -fsSL https://get.docker.com | sh"
    echo ""
fi

# Download latest release
echo "Downloading orca-daemon for $ARCH..."
if [ "$VERSION" = "latest" ]; then
    DOWNLOAD_URL="https://github.com/$REPO/releases/latest/download/orca-daemon-linux-$ARCH"
else
    DOWNLOAD_URL="https://github.com/$REPO/releases/download/$VERSION/orca-daemon-linux-$ARCH"
fi

if command -v curl &>/dev/null; then
    curl -fsSL -o "$INSTALL_DIR/orca-daemon" "$DOWNLOAD_URL"
elif command -v wget &>/dev/null; then
    wget -qO "$INSTALL_DIR/orca-daemon" "$DOWNLOAD_URL"
else
    echo "Error: curl or wget is required"
    exit 1
fi

chmod +x "$INSTALL_DIR/orca-daemon"
echo "Installed to $INSTALL_DIR/orca-daemon"

# Create config directory
mkdir -p "$CONFIG_DIR"

# Generate API token if not exists
if [ ! -f "$CONFIG_DIR/config.json" ]; then
    TOKEN=$(openssl rand -hex 32)
    cat > "$CONFIG_DIR/config.json" << EOF
{
  "api_token": "$TOKEN"
}
EOF
    chmod 600 "$CONFIG_DIR/config.json"
    echo "Generated API token"
else
    TOKEN=$(grep -o '"api_token"[[:space:]]*:[[:space:]]*"[^"]*"' "$CONFIG_DIR/config.json" | cut -d'"' -f4)
    echo "Using existing API token"
fi

# Install systemd service
cat > "$SERVICE_FILE" << 'SERVICEEOF'
[Unit]
Description=Orca Container Management Daemon
Documentation=https://orca-desktop.com
After=network.target docker.service containerd.service
Wants=docker.service

[Service]
Type=simple
ExecStart=/usr/local/bin/orca-daemon --host 0.0.0.0
Restart=always
RestartSec=5
User=root
Group=root
StandardOutput=journal
StandardError=journal
SyslogIdentifier=orca-daemon
Environment=RUST_LOG=info

[Install]
WantedBy=multi-user.target
SERVICEEOF

systemctl daemon-reload
systemctl enable orca-daemon
systemctl start orca-daemon

echo ""
echo "=== Orca Daemon Installed ==="
echo ""
echo "Status:  systemctl status orca-daemon"
echo "Logs:    journalctl -u orca-daemon -f"
echo "Config:  $CONFIG_DIR/config.json"
echo ""
echo "=== Connection Details ==="
echo ""
HOSTNAME=$(hostname -f 2>/dev/null || hostname)
IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "YOUR_IP")
echo "URL:     https://$HOSTNAME:9477/api/v1"
echo "         (or http://$IP:9477/api/v1 without TLS)"
echo "Token:   $TOKEN"
echo ""
echo "Add this host in Orca Desktop:"
echo "  Settings -> Remote Hosts -> Add Host"
echo ""
echo "IMPORTANT: For production use, set up TLS (HTTPS):"
echo "  - Use a reverse proxy (Caddy, nginx) with TLS termination"
echo "  - Or use a VPN/SSH tunnel for secure access"
echo ""
