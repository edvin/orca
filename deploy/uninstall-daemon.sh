#!/bin/bash
set -euo pipefail

echo "=== Uninstalling Orca Daemon ==="

if [ "$(id -u)" -ne 0 ]; then
    echo "Error: This script must be run as root (use sudo)"
    exit 1
fi

systemctl stop orca-daemon 2>/dev/null || true
systemctl disable orca-daemon 2>/dev/null || true
rm -f /etc/systemd/system/orca-daemon.service
systemctl daemon-reload

rm -f /usr/local/bin/orca-daemon

echo ""
echo "Orca daemon removed."
echo "Config preserved at /etc/orca/ — delete manually if not needed."
