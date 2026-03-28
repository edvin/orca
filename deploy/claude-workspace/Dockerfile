FROM node:20-bookworm

ENV DEBIAN_FRONTEND=noninteractive

# System tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl wget unzip zip jq vim nano less \
    build-essential cmake pkg-config \
    ca-certificates openssh-client \
    python3 python3-pip python3-venv \
    php8.2-cli php8.2-mbstring php8.2-xml php8.2-curl php8.2-zip \
    && rm -rf /var/lib/apt/lists/*

# Go
RUN ARCH=$(dpkg --print-architecture) && \
    curl -fsSL "https://go.dev/dl/go1.24.1.linux-${ARCH}.tar.gz" | tar -C /usr/local -xz
ENV PATH="/usr/local/go/bin:/root/go/bin:${PATH}"

# Rust
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
ENV PATH="/root/.cargo/bin:${PATH}"

# PHP Composer
RUN curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer

# Python tools
RUN rm -f /usr/lib/python3.*/EXTERNALLY-MANAGED && \
    pip3 install --no-cache-dir pipenv poetry black ruff mypy

# Node tools
RUN npm install -g typescript tsx pnpm yarn

# Claude CLI (installed separately — large package)
RUN npm install -g @anthropic-ai/claude-code

# Go tools
RUN go install golang.org/x/tools/gopls@latest && \
    go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest

# Rust tools
RUN cargo install cargo-watch && \
    rm -rf /root/.cargo/registry /root/.cargo/git

# GitHub CLI
RUN ARCH=$(dpkg --print-architecture) && \
    curl -fsSL "https://github.com/cli/cli/releases/download/v2.67.0/gh_2.67.0_linux_${ARCH}.deb" -o /tmp/gh.deb && \
    dpkg -i /tmp/gh.deb && rm /tmp/gh.deb

# Docker CLI only (not the full engine)
RUN ARCH=$(dpkg --print-architecture) && \
    curl -fsSL "https://download.docker.com/linux/static/stable/$(uname -m)/docker-27.5.1.tgz" | \
    tar -xz -C /tmp && mv /tmp/docker/docker /usr/local/bin/ && rm -rf /tmp/docker

WORKDIR /workspace

CMD ["bash"]
