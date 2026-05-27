FROM node:20-bookworm

ENV DEBIAN_FRONTEND=noninteractive

# System tools (+ sudo so the non-root workspace user can install extras)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl wget unzip zip jq vim nano less \
    build-essential cmake pkg-config \
    ca-certificates openssh-client sudo \
    python3 python3-pip python3-venv \
    php8.2-cli php8.2-mbstring php8.2-xml php8.2-curl php8.2-zip \
    && rm -rf /var/lib/apt/lists/*

# The base node:20 image ships a stock non-root user `node`. Rename it to `dev`
# (keeping uid/gid 1000 — matches the typical host user, so bind-mounted file
# ownership stays sane); this is a polyglot workspace, not just Node.
RUN groupmod -n dev node && usermod -l dev -d /home/dev -m node

# Go toolchain (global). Per-tool binaries go to a shared GOBIN below.
RUN ARCH=$(dpkg --print-architecture) && \
    curl -fsSL "https://go.dev/dl/go1.24.1.linux-${ARCH}.tar.gz" | tar -C /usr/local -xz
ENV PATH="/usr/local/go/bin:/home/dev/go/bin:${PATH}"

# Rust — installed system-wide (not /root) so the non-root user can use it.
# World-writable RUSTUP_HOME/CARGO_HOME let that user `cargo install` at runtime.
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:/usr/local/go/bin:/home/dev/go/bin:/home/dev/.npm-global/bin:${PATH}
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | \
        sh -s -- -y --no-modify-path --default-toolchain stable && \
    chmod -R a+w "$RUSTUP_HOME" "$CARGO_HOME"

# PHP Composer
RUN curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer

# Python tools
RUN rm -f /usr/lib/python3.*/EXTERNALLY-MANAGED && \
    pip3 install --no-cache-dir pipenv poetry black ruff mypy

# Node global tools are installed as the `dev` user further down (see the
# npm install after USER dev) so they live in a user-writable prefix —
# notably letting `claude` self-update. yarn is already in the base image.

# Go tools → shared GOBIN on PATH for every user (GOBIN is build-only, not a
# persistent ENV, so the user's own `go install` falls back to ~/go/bin).
RUN GOBIN=/usr/local/bin go install golang.org/x/tools/gopls@latest && \
    GOBIN=/usr/local/bin go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest && \
    rm -rf /root/go

# Rust tools (into the shared CARGO_HOME/bin)
RUN cargo install cargo-watch && \
    rm -rf "$CARGO_HOME/registry" "$CARGO_HOME/git" && \
    chmod -R a+w "$CARGO_HOME"

# GitHub CLI
RUN ARCH=$(dpkg --print-architecture) && \
    curl -fsSL "https://github.com/cli/cli/releases/download/v2.67.0/gh_2.67.0_linux_${ARCH}.deb" -o /tmp/gh.deb && \
    dpkg -i /tmp/gh.deb && rm /tmp/gh.deb

# Docker CLI only (not the full engine)
RUN ARCH=$(dpkg --print-architecture) && \
    curl -fsSL "https://download.docker.com/linux/static/stable/$(uname -m)/docker-27.5.1.tgz" | \
    tar -xz -C /tmp && mv /tmp/docker/docker /usr/local/bin/ && rm -rf /tmp/docker

# Run as the non-root `dev` user (renamed from the base image's `node`, uid
# 1000). Claude Code refuses `--dangerously-skip-permissions` under root, so
# running as root made the workspace's whole point — autonomous `claude` —
# impossible. As a bonus, files written into the mounted project are no longer
# owned by root on the host. Passwordless sudo keeps ad-hoc `apt install` etc.
# available; safe.directory stops git's "dubious ownership" error on /workspace.
RUN echo 'dev ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/dev && \
    chmod 0440 /etc/sudoers.d/dev && \
    git config --system --add safe.directory '*' && \
    mkdir -p /workspace && chown dev:dev /workspace && \
    # Login shells (bash -l) source /etc/profile, which OVERWRITES PATH and
    # would drop the Rust/Go dirs the ENV below sets — re-add them here so go,
    # cargo, rustc, etc. resolve in every shell, not just docker exec.
    printf '%s\n' \
      'export RUSTUP_HOME=/usr/local/rustup' \
      'export CARGO_HOME=/usr/local/cargo' \
      'export GOPATH="$HOME/go"' \
      'export NPM_CONFIG_PREFIX="$HOME/.npm-global"' \
      'export PATH="/usr/local/cargo/bin:/usr/local/go/bin:$HOME/go/bin:$HOME/.npm-global/bin:$PATH"' \
      > /etc/profile.d/dev-tools.sh
# npm global prefix in the user's home so `npm i -g` (incl. claude's own
# self-update) doesn't need write access to root-owned /usr/local.
ENV GOPATH=/home/dev/go \
    NPM_CONFIG_PREFIX=/home/dev/.npm-global
WORKDIR /workspace
USER dev

# Install global Node tools as `dev` (not root) so they're user-owned and
# updatable — claude can self-update via `npm i -g @anthropic-ai/claude-code`.
RUN npm install -g typescript tsx pnpm @anthropic-ai/claude-code

CMD ["bash"]
