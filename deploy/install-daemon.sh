#!/bin/bash
set -euo pipefail

# Orca Daemon Installer for Linux
# Usage: curl -fsSL https://orca-desktop.com/install-daemon.sh | sudo sh

echo "=== Orca Daemon Installer ==="
echo ""

# Check root
if [ "$(id -u)" -ne 0 ]; then
    echo "Error: This script must be run as root (use sudo)"
    exit 1
fi

# Detect OS
if [ ! -f /etc/os-release ]; then
    echo "Error: Cannot detect OS (missing /etc/os-release)"
    exit 1
fi
. /etc/os-release

# Check for Docker
if ! command -v docker &>/dev/null; then
    echo "Warning: Docker is not installed."
    echo "Install Docker first: curl -fsSL https://get.docker.com | sh"
    echo ""
fi

# Install via Cloudsmith apt repo
echo "Adding Orca repository..."
if ! command -v curl &>/dev/null; then
    apt-get update -qq && apt-get install -y -qq curl
fi

curl -1sLf 'https://dl.cloudsmith.io/public/edvin/orca/setup.deb.sh' | bash

echo "Installing orca-daemon..."
apt-get install -y orca-daemon

# Print connection info
echo ""
echo "=== Orca Daemon Installed ==="
echo ""
echo "Status:  systemctl status orca-daemon"
echo "Logs:    journalctl -u orca-daemon -f"
echo "Config:  /etc/orca/config.json"
echo ""

if [ -f /etc/orca/config.json ]; then
    TOKEN=$(grep -o '"api_token"[[:space:]]*:[[:space:]]*"[^"]*"' /etc/orca/config.json | cut -d'"' -f4)
    IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "YOUR_IP")
    echo "=== Connection Details ==="
    echo ""
    echo "URL:     http://$IP:9477/api/v1"
    echo "Token:   $TOKEN"
    echo ""
    echo "Add this host in Orca Desktop:"
    echo "  Settings → Remote Hosts → Add Host"
    echo ""
    echo "IMPORTANT: For production use, set up TLS (HTTPS):"
    echo "  Use a reverse proxy (Caddy, nginx) or SSH tunnel."
    echo "  See: https://github.com/edvin/orca/blob/main/docs/remote-management.md"
fi
