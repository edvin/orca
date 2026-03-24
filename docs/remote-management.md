# Remote Management

Orca can manage Docker containers on remote Linux servers via the Orca daemon (`orca-daemon`). The daemon exposes a REST API that Orca Desktop connects to, giving you a single interface to manage containers across all your servers.

## Prerequisites

- A Linux server (Ubuntu 22.04+, Debian 12+, or Fedora 39+)
- Docker installed on the remote server
- Network access from your desktop to the server on port 9477
- TLS termination (reverse proxy or VPN) for production use

## Quick Start

Run this on your remote server:

```bash
curl -fsSL https://orca-desktop.com/install-daemon.sh | sudo sh
```

The installer will:

1. Download the correct binary for your architecture (x86_64 or aarch64)
2. Generate an API token
3. Install and start the systemd service
4. Print connection details

Save the displayed API token -- you will need it to connect from Orca Desktop.

## Manual Installation

### Download the binary

```bash
# x86_64
sudo curl -fsSL -o /usr/local/bin/orca-daemon \
  https://github.com/edvin/orca/releases/latest/download/orca-daemon-linux-x86_64

# aarch64 / ARM64
sudo curl -fsSL -o /usr/local/bin/orca-daemon \
  https://github.com/edvin/orca/releases/latest/download/orca-daemon-linux-aarch64

sudo chmod +x /usr/local/bin/orca-daemon
```

### Create config

```bash
sudo mkdir -p /etc/orca
TOKEN=$(openssl rand -hex 32)
sudo tee /etc/orca/config.json > /dev/null << EOF
{
  "api_token": "$TOKEN"
}
EOF
sudo chmod 600 /etc/orca/config.json
echo "Your API token: $TOKEN"
```

### Install the systemd service

```bash
sudo cp deploy/orca-daemon.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now orca-daemon
```

### Verify

```bash
systemctl status orca-daemon
journalctl -u orca-daemon -f
```

## Connecting from Orca Desktop

1. Open Orca Desktop
2. Go to **Settings** then **Remote Hosts** then **Add Host**
3. Enter the server URL: `http://YOUR_SERVER_IP:9477/api/v1`
4. Paste the API token from the installation output
5. Click **Connect**

The remote server's containers will appear alongside your local containers.

## TLS Setup

**Do not expose port 9477 over the internet without TLS.** Use one of these approaches:

### Option A: Caddy (automatic TLS)

Caddy obtains and renews certificates automatically via Let's Encrypt.

```bash
sudo apt install caddy   # or dnf install caddy
```

Create `/etc/caddy/Caddyfile`:

```
orca.example.com {
    reverse_proxy localhost:9477
}
```

```bash
sudo systemctl restart caddy
```

Then connect from Orca Desktop using `https://orca.example.com/api/v1`.

### Option B: Nginx with Let's Encrypt

```bash
sudo apt install nginx certbot python3-certbot-nginx
sudo certbot --nginx -d orca.example.com
```

Create `/etc/nginx/sites-available/orca-daemon.conf`:

```nginx
server {
    listen 443 ssl http2;
    server_name orca.example.com;

    ssl_certificate /etc/letsencrypt/live/orca.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/orca.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:9477;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket support (for terminal)
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # SSE support (for logs, build streaming)
        proxy_buffering off;
        proxy_cache off;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/orca-daemon.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### Option C: SSH Tunnel

No TLS setup needed. Create a tunnel from your desktop:

```bash
ssh -L 9477:localhost:9477 user@your-server
```

Then connect from Orca Desktop using `http://localhost:9477/api/v1`.

For a persistent tunnel, add to your `~/.ssh/config`:

```
Host orca-server
    HostName your-server.example.com
    User your-user
    LocalForward 9477 localhost:9477
```

## Firewall Configuration

If you are using a reverse proxy (Caddy/nginx), only expose ports 80 and 443. Keep port 9477 local:

```bash
# UFW (Ubuntu/Debian)
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
# Do NOT run: sudo ufw allow 9477/tcp

# firewalld (Fedora)
sudo firewall-cmd --permanent --add-service=http
sudo firewall-cmd --permanent --add-service=https
sudo firewall-cmd --reload
```

If connecting directly without a reverse proxy (development/LAN only):

```bash
# UFW
sudo ufw allow 9477/tcp

# firewalld
sudo firewall-cmd --permanent --add-port=9477/tcp
sudo firewall-cmd --reload
```

## Updating the Daemon

```bash
# Download the new version
sudo curl -fsSL -o /usr/local/bin/orca-daemon \
  https://github.com/edvin/orca/releases/latest/download/orca-daemon-linux-$(uname -m)
sudo chmod +x /usr/local/bin/orca-daemon

# Restart the service
sudo systemctl restart orca-daemon
```

Or re-run the install script -- it preserves your existing config and API token:

```bash
curl -fsSL https://orca-desktop.com/install-daemon.sh | sudo sh
```

## Uninstalling

```bash
curl -fsSL https://raw.githubusercontent.com/edvin/orca/main/deploy/uninstall-daemon.sh | sudo sh
```

Or manually:

```bash
sudo systemctl stop orca-daemon
sudo systemctl disable orca-daemon
sudo rm /etc/systemd/system/orca-daemon.service
sudo systemctl daemon-reload
sudo rm /usr/local/bin/orca-daemon
# Optionally remove config:
# sudo rm -rf /etc/orca
```

## Troubleshooting

### Daemon won't start

Check the logs:

```bash
journalctl -u orca-daemon -e --no-pager
```

Common causes:
- Docker is not installed or not running: `sudo systemctl start docker`
- Port 9477 already in use: `sudo ss -tlnp | grep 9477`
- Binary is not executable: `sudo chmod +x /usr/local/bin/orca-daemon`

### Cannot connect from Orca Desktop

- Verify the daemon is running: `systemctl status orca-daemon`
- Test locally on the server: `curl http://localhost:9477/api/v1/health`
- Check firewall rules are not blocking port 9477
- Ensure you are using the correct API token from `/etc/orca/config.json`

### Connection refused or timeout

- If using a reverse proxy, check that it is running and configured correctly
- If connecting directly, ensure port 9477 is open in your firewall
- Try an SSH tunnel to rule out network issues

### Permission denied errors

The daemon runs as root to access the Docker socket. If you see permission errors:

```bash
ls -la /var/run/docker.sock
# Should show: srw-rw---- root docker
```

### High CPU or memory usage

Increase the log level for debugging, then revert:

```bash
sudo systemctl edit orca-daemon
# Add: Environment=RUST_LOG=debug
sudo systemctl restart orca-daemon
# After debugging:
sudo systemctl revert orca-daemon
sudo systemctl restart orca-daemon
```

## Security Considerations

- **Always use TLS in production.** The API token is sent in HTTP headers and can be intercepted without encryption.
- **Restrict network access.** Only allow connections from trusted IPs or networks.
- **Rotate API tokens periodically.** Edit `/etc/orca/config.json` and restart the daemon.
- **The daemon runs as root** because it needs access to the Docker socket. This is the same privilege level as running `docker` commands directly.
- **Keep the daemon updated** to receive security patches.
- **Audit access.** Check daemon logs for unauthorized connection attempts: `journalctl -u orca-daemon | grep -i auth`.
