use orca_core::templates::AppTemplate;

/// Generate a random alphanumeric token for services that need one.
fn generate_token() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    // Simple xorshift-based PRNG — good enough for a default token
    let mut state = seed as u64 | 1;
    let chars: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    (0..32)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            chars[(state as usize) % chars.len()] as char
        })
        .collect()
}

pub fn builtin_templates() -> Vec<AppTemplate> {
    let mut templates = vec![
        // Databases
        AppTemplate {
            id: "postgres".to_string(),
            name: "PostgreSQL".to_string(),
            description: "The world's most advanced open source relational database".to_string(),
            icon: r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3"/></svg>"#.to_string(),
            category: "Database".to_string(),
            image: "postgres:16-alpine".to_string(),
            default_ports: vec!["5432:5432".to_string()],
            default_env: vec!["POSTGRES_PASSWORD=changeme".to_string(), "POSTGRES_DB=mydb".to_string()],
            default_volumes: vec!["pgdata:/var/lib/postgresql/data".to_string()],
            restart_policy: "unless-stopped".to_string(),
            is_builtin: false,
            notes: "Connect with: psql -h localhost -U postgres -d mydb".to_string(),
        },
        AppTemplate {
            id: "mysql".to_string(),
            name: "MySQL".to_string(),
            description: "Popular open source relational database".to_string(),
            icon: r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3"/><path d="M3 8.5c0 1.66 4 3 9 3s9-1.34 9-3"/></svg>"#.to_string(),
            category: "Database".to_string(),
            image: "mysql:8".to_string(),
            default_ports: vec!["3306:3306".to_string()],
            default_env: vec!["MYSQL_ROOT_PASSWORD=changeme".to_string(), "MYSQL_DATABASE=mydb".to_string()],
            default_volumes: vec!["mysqldata:/var/lib/mysql".to_string()],
            restart_policy: "unless-stopped".to_string(),
            is_builtin: false,
            notes: "Connect with: mysql -h 127.0.0.1 -u root -p".to_string(),
        },
        AppTemplate {
            id: "redis".to_string(),
            name: "Redis".to_string(),
            description: "In-memory data store, cache, and message broker".to_string(),
            icon: r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2" transform="rotate(45 12 12)"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>"#.to_string(),
            category: "Database".to_string(),
            image: "redis:alpine".to_string(),
            default_ports: vec!["6379:6379".to_string()],
            default_env: vec![],
            default_volumes: vec!["redisdata:/data".to_string()],
            restart_policy: "unless-stopped".to_string(),
            is_builtin: false,
            notes: "Connect with: redis-cli".to_string(),
        },
        AppTemplate {
            id: "mongodb".to_string(),
            name: "MongoDB".to_string(),
            description: "Document-oriented NoSQL database".to_string(),
            icon: r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 8c0 4-5 8-5 14 0-6-5-10-5-14a5 5 0 0 1 10 0z"/><path d="M12 22v-8"/></svg>"#.to_string(),
            category: "Database".to_string(),
            image: "mongo:7".to_string(),
            default_ports: vec!["27017:27017".to_string()],
            default_env: vec!["MONGO_INITDB_ROOT_USERNAME=admin".to_string(), "MONGO_INITDB_ROOT_PASSWORD=changeme".to_string()],
            default_volumes: vec!["mongodata:/data/db".to_string()],
            restart_policy: "unless-stopped".to_string(),
            is_builtin: false,
            notes: "Connect with: mongosh -u admin -p changeme".to_string(),
        },
        // Web Servers
        AppTemplate {
            id: "nginx".to_string(),
            name: "Nginx".to_string(),
            description: "High-performance web server and reverse proxy".to_string(),
            icon: r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>"#.to_string(),
            category: "Web Server".to_string(),
            image: "nginx:alpine".to_string(),
            default_ports: vec!["8080:80".to_string()],
            default_env: vec![],
            default_volumes: vec![],
            restart_policy: "unless-stopped".to_string(),
            is_builtin: false,
            notes: "Serve files from /usr/share/nginx/html".to_string(),
        },
        AppTemplate {
            id: "caddy".to_string(),
            name: "Caddy".to_string(),
            description: "Fast web server with automatic HTTPS".to_string(),
            icon: r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/><circle cx="12" cy="16" r="1"/></svg>"#.to_string(),
            category: "Web Server".to_string(),
            image: "caddy:alpine".to_string(),
            default_ports: vec!["80:80".to_string(), "443:443".to_string()],
            default_env: vec![],
            default_volumes: vec!["caddydata:/data".to_string(), "caddyconfig:/config".to_string()],
            restart_policy: "unless-stopped".to_string(),
            is_builtin: false,
            notes: "Configure via Caddyfile at /etc/caddy/Caddyfile".to_string(),
        },
        // Monitoring
        AppTemplate {
            id: "grafana".to_string(),
            name: "Grafana".to_string(),
            description: "Observability dashboards and visualization".to_string(),
            icon: r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 20V10"/><path d="M12 20V4"/><path d="M6 20v-6"/><rect x="2" y="2" width="20" height="20" rx="2"/></svg>"#.to_string(),
            category: "Monitoring".to_string(),
            image: "grafana/grafana:latest".to_string(),
            default_ports: vec!["3000:3000".to_string()],
            default_env: vec!["GF_SECURITY_ADMIN_PASSWORD=admin".to_string()],
            default_volumes: vec!["grafanadata:/var/lib/grafana".to_string()],
            restart_policy: "unless-stopped".to_string(),
            is_builtin: false,
            notes: "Login at http://localhost:3000 with admin/admin".to_string(),
        },
        AppTemplate {
            id: "prometheus".to_string(),
            name: "Prometheus".to_string(),
            description: "Monitoring and alerting toolkit".to_string(),
            icon: r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2c1 3 3 5 5 6-1 3-2 6-5 8-3-2-4-5-5-8 2-1 4-3 5-6z"/><path d="M12 16v6"/><path d="M8 22h8"/></svg>"#.to_string(),
            category: "Monitoring".to_string(),
            image: "prom/prometheus:latest".to_string(),
            default_ports: vec!["9090:9090".to_string()],
            default_env: vec![],
            default_volumes: vec!["promdata:/prometheus".to_string()],
            restart_policy: "unless-stopped".to_string(),
            is_builtin: false,
            notes: "Dashboard at http://localhost:9090".to_string(),
        },
        // Storage
        AppTemplate {
            id: "minio".to_string(),
            name: "MinIO".to_string(),
            description: "S3-compatible object storage".to_string(),
            icon: r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>"#.to_string(),
            category: "Storage".to_string(),
            image: "minio/minio:latest".to_string(),
            default_ports: vec!["9000:9000".to_string(), "9001:9001".to_string()],
            default_env: vec!["MINIO_ROOT_USER=minioadmin".to_string(), "MINIO_ROOT_PASSWORD=minioadmin".to_string()],
            default_volumes: vec!["miniodata:/data".to_string()],
            restart_policy: "unless-stopped".to_string(),
            is_builtin: false,
            notes: "Console at http://localhost:9001".to_string(),
        },
        // Tools
        AppTemplate {
            id: "phpmyadmin".to_string(),
            name: "phpMyAdmin".to_string(),
            description: "Web-based MySQL/MariaDB administration tool".to_string(),
            icon: r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3"/><path d="M15 13l2 2-2 2"/><path d="M9 13l-2 2 2 2"/></svg>"#.to_string(),
            category: "Tools".to_string(),
            image: "phpmyadmin:latest".to_string(),
            default_ports: vec!["8082:80".to_string()],
            default_env: vec![
                "PMA_HOST=orca-mysql".to_string(),
                "PMA_PORT=3306".to_string(),
                "PMA_ARBITRARY=1".to_string(),
            ],
            default_volumes: vec![],
            restart_policy: "no".to_string(),
            is_builtin: false,
            notes: "Open http://localhost:8082. Set PMA_HOST to your MySQL/MariaDB container name. PMA_ARBITRARY=1 allows connecting to any server.".to_string(),
        },
        AppTemplate {
            id: "adminer".to_string(),
            name: "Adminer".to_string(),
            description: "Database management in a single PHP file".to_string(),
            icon: r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3"/><circle cx="12" cy="12" r="1"/></svg>"#.to_string(),
            category: "Tools".to_string(),
            image: "adminer:latest".to_string(),
            default_ports: vec!["8081:8080".to_string()],
            default_env: vec![],
            default_volumes: vec![],
            restart_policy: "no".to_string(),
            is_builtin: false,
            notes: "Open http://localhost:8081 to manage databases".to_string(),
        },
        AppTemplate {
            id: "mailhog".to_string(),
            name: "MailHog".to_string(),
            description: "Email testing tool for developers".to_string(),
            icon: r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>"#.to_string(),
            category: "Tools".to_string(),
            image: "mailhog/mailhog:latest".to_string(),
            default_ports: vec!["1025:1025".to_string(), "8025:8025".to_string()],
            default_env: vec![],
            default_volumes: vec![],
            restart_policy: "no".to_string(),
            is_builtin: false,
            notes: "SMTP on port 1025, Web UI at http://localhost:8025".to_string(),
        },
        AppTemplate {
            id: "portainer".to_string(),
            name: "Portainer".to_string(),
            description: "Container management UI".to_string(),
            icon: r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/><line x1="12" y1="12" x2="12" y2="16"/><line x1="10" y1="14" x2="14" y2="14"/></svg>"#.to_string(),
            category: "Tools".to_string(),
            image: "portainer/portainer-ce:latest".to_string(),
            default_ports: vec!["9443:9443".to_string()],
            default_env: vec![],
            default_volumes: vec!["/var/run/docker.sock:/var/run/docker.sock".to_string(), "portainerdata:/data".to_string()],
            restart_policy: "unless-stopped".to_string(),
            is_builtin: false,
            notes: "Access at https://localhost:9443".to_string(),
        },
        // Development Tools
        AppTemplate {
            id: "gitlab".to_string(),
            name: "GitLab".to_string(),
            description: "Self-hosted Git repository and CI/CD".to_string(),
            icon: r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M11 18H8a2 2 0 0 1-2-2V9"/></svg>"#.to_string(),
            category: "Development".to_string(),
            image: "gitlab/gitlab-ce:latest".to_string(),
            default_ports: vec!["8080:80".to_string(), "8443:443".to_string(), "2222:22".to_string()],
            default_env: vec!["GITLAB_ROOT_PASSWORD=changeme".to_string()],
            default_volumes: vec!["gitlab-config:/etc/gitlab".to_string(), "gitlab-logs:/var/log/gitlab".to_string(), "gitlab-data:/var/opt/gitlab".to_string()],
            restart_policy: "unless-stopped".to_string(),
            is_builtin: false,
            notes: "Access at http://localhost:8080. Login with root/changeme. First start takes several minutes.".to_string(),
        },
        AppTemplate {
            id: "gitea".to_string(),
            name: "Gitea".to_string(),
            description: "Lightweight self-hosted Git service".to_string(),
            icon: r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 8h1a4 4 0 1 1 0 8h-1"/><path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V8z"/><line x1="6" y1="2" x2="6" y2="4"/><line x1="10" y1="2" x2="10" y2="4"/><line x1="14" y1="2" x2="14" y2="4"/></svg>"#.to_string(),
            category: "Development".to_string(),
            image: "gitea/gitea:latest".to_string(),
            default_ports: vec!["3000:3000".to_string(), "2222:22".to_string()],
            default_env: vec![],
            default_volumes: vec!["gitea-data:/data".to_string()],
            restart_policy: "unless-stopped".to_string(),
            is_builtin: false,
            notes: "Setup wizard at http://localhost:3000".to_string(),
        },
        // Message Queues
        AppTemplate {
            id: "rabbitmq".to_string(),
            name: "RabbitMQ".to_string(),
            description: "Message broker with management UI".to_string(),
            icon: r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 10h8"/><path d="M8 14h4"/></svg>"#.to_string(),
            category: "Message Queue".to_string(),
            image: "rabbitmq:3-management".to_string(),
            default_ports: vec!["5672:5672".to_string(), "15672:15672".to_string()],
            default_env: vec!["RABBITMQ_DEFAULT_USER=admin".to_string(), "RABBITMQ_DEFAULT_PASS=changeme".to_string()],
            default_volumes: vec!["rabbitmq-data:/var/lib/rabbitmq".to_string()],
            restart_policy: "unless-stopped".to_string(),
            is_builtin: false,
            notes: "Management UI at http://localhost:15672 (admin/changeme)".to_string(),
        },
        // Search
        AppTemplate {
            id: "elasticsearch".to_string(),
            name: "Elasticsearch".to_string(),
            description: "Distributed search and analytics engine".to_string(),
            icon: r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>"#.to_string(),
            category: "Search".to_string(),
            image: "elasticsearch:8.15.0".to_string(),
            default_ports: vec!["9200:9200".to_string()],
            default_env: vec!["discovery.type=single-node".to_string(), "xpack.security.enabled=false".to_string(), "ES_JAVA_OPTS=-Xms512m -Xmx512m".to_string()],
            default_volumes: vec!["es-data:/usr/share/elasticsearch/data".to_string()],
            restart_policy: "unless-stopped".to_string(),
            is_builtin: false,
            notes: "API at http://localhost:9200".to_string(),
        },
        // More Message Queues
        AppTemplate {
            id: "nats".to_string(),
            name: "NATS JetStream".to_string(),
            description: "Cloud-native messaging with persistent streaming".to_string(),
            icon: r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>"#.to_string(),
            category: "Message Queue".to_string(),
            image: "nats:latest".to_string(),
            default_ports: vec!["4222:4222".to_string(), "8222:8222".to_string()],
            default_env: vec![],
            default_volumes: vec!["nats-data:/data".to_string()],
            restart_policy: "unless-stopped".to_string(),
            is_builtin: false,
            notes: "Client port 4222, monitoring at http://localhost:8222. JetStream is enabled by default in recent versions.".to_string(),
        },
        // More Search
        AppTemplate {
            id: "meilisearch".to_string(),
            name: "Meilisearch".to_string(),
            description: "Lightning-fast, typo-tolerant search engine".to_string(),
            icon: r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg>"#.to_string(),
            category: "Search".to_string(),
            image: "getmeili/meilisearch:latest".to_string(),
            default_ports: vec!["7700:7700".to_string()],
            default_env: vec!["MEILI_ENV=development".to_string()],
            default_volumes: vec!["meili-data:/meili_data".to_string()],
            restart_policy: "unless-stopped".to_string(),
            is_builtin: false,
            notes: "Dashboard at http://localhost:7700. Set MEILI_MASTER_KEY for production use.".to_string(),
        },
        // AI Assistants
        AppTemplate {
            id: "openclaw".to_string(),
            name: "OpenClaw".to_string(),
            description: "Personal AI assistant — connects to WhatsApp, Telegram, Slack, and more".to_string(),
            icon: r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><path d="M12 2a4 4 0 0 0-4 4v5h8V6a4 4 0 0 0-4-4z"/><circle cx="9" cy="16" r="1"/><circle cx="15" cy="16" r="1"/></svg>"#.to_string(),
            category: "AI".to_string(),
            image: "ghcr.io/openclaw/openclaw:latest".to_string(),
            default_ports: vec!["18789:18789".to_string(), "18790:18790".to_string()],
            default_env: vec![
                "NODE_ENV=production".to_string(),
                format!("OPENCLAW_GATEWAY_TOKEN={}", generate_token()),
                "OPENCLAW_GATEWAY_BIND=lan".to_string(),
            ],
            default_volumes: vec![
                "openclaw-config:/home/node/.openclaw".to_string(),
                "openclaw-workspace:/home/node/.openclaw/workspace".to_string(),
            ],
            restart_policy: "unless-stopped".to_string(),
            is_builtin: false,
            notes: "Gateway UI at http://localhost:18789. Enter the OPENCLAW_GATEWAY_TOKEN value in Settings to authenticate. Configure your AI provider API keys and messaging channels from the web interface.".to_string(),
        },
        // More Databases
        AppTemplate {
            id: "mariadb".to_string(),
            name: "MariaDB".to_string(),
            description: "Community-developed MySQL fork".to_string(),
            icon: r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/><path d="M3 9c0 1.66 4 3 9 3s9-1.34 9-3"/><path d="M3 14c0 1.66 4 3 9 3s9-1.34 9-3"/></svg>"#.to_string(),
            category: "Database".to_string(),
            image: "mariadb:11".to_string(),
            default_ports: vec!["3306:3306".to_string()],
            default_env: vec!["MARIADB_ROOT_PASSWORD=changeme".to_string(), "MARIADB_DATABASE=mydb".to_string()],
            default_volumes: vec!["mariadb-data:/var/lib/mysql".to_string()],
            restart_policy: "unless-stopped".to_string(),
            is_builtin: false,
            notes: "Connect with: mariadb -h 127.0.0.1 -u root -p".to_string(),
        },
        // AI
        AppTemplate {
            id: "ollama".to_string(),
            name: "Ollama".to_string(),
            description: "Run open-source LLMs locally with tool calling support. Use as Orca's AI assistant with no API keys needed.".to_string(),
            icon: r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a7 7 0 0 0-7 7c0 3 2 5 4 7h6c2-2 4-4 4-7a7 7 0 0 0-7-7z"/><path d="M9 16v2a3 3 0 0 0 6 0v-2"/><path d="M9 10h0"/><path d="M15 10h0"/></svg>"#.to_string(),
            category: "AI".to_string(),
            image: "ollama/ollama:latest".to_string(),
            default_ports: vec!["11434:11434".to_string()],
            default_env: vec![],
            default_volumes: vec!["ollama-models:/root/.ollama".to_string()],
            restart_policy: "unless-stopped".to_string(),
            is_builtin: false,
            notes: "After starting, pull a model with tool support:\n  docker exec ollama ollama pull qwen2.5:7b\n\nThen in Settings → AI, select 'Ollama (Local)' — or click 'Set up Ollama' for automatic setup.\n\nNo API key needed.".to_string(),
        },
        AppTemplate {
            id: "open-webui".to_string(),
            name: "Open WebUI".to_string(),
            description: "Beautiful web interface for Ollama and other LLM backends. ChatGPT-like experience with local models.".to_string(),
            icon: r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>"#.to_string(),
            category: "AI".to_string(),
            image: "ghcr.io/open-webui/open-webui:main".to_string(),
            default_ports: vec!["3000:8080".to_string()],
            default_env: vec!["OLLAMA_BASE_URL=http://host.docker.internal:11434".to_string()],
            default_volumes: vec!["open-webui-data:/app/backend/data".to_string()],
            restart_policy: "unless-stopped".to_string(),
            is_builtin: false,
            notes: "Web UI at http://localhost:3000. Requires Ollama running (deploy it first from App Catalog). Create an account on first visit.".to_string(),
        },
        // Dev Tools
        AppTemplate {
            id: "claude-workspace".to_string(),
            name: "Claude Code Workspace".to_string(),
            description: "Full dev environment with Claude CLI, Node, Python, Go, Rust, PHP, and common tools. Mount your project and start coding with AI.".to_string(),
            icon: r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>"#.to_string(),
            category: "Dev Tools".to_string(),
            image: "ghcr.io/edvin/orca-claude-workspace:latest".to_string(),
            default_ports: vec![],
            default_env: vec!["ANTHROPIC_API_KEY=your-key-here".to_string()],
            default_volumes: vec![],
            restart_policy: "no".to_string(),
            is_builtin: false,
            notes: "Mount your project directory as a volume (e.g., /home/user/myproject:/workspace).\n\nSet your ANTHROPIC_API_KEY in the environment variables above.\n\nIncludes: Node 20, Python 3, Go, Rust, PHP 8, Claude CLI, TypeScript, pnpm, Docker CLI, GitHub CLI.\n\nOpen a terminal into the container to start using Claude Code.".to_string(),
        },
    ];
    for t in &mut templates {
        t.is_builtin = true;
        // Replace placeholder passwords with generated ones
        let pw = generate_token();
        let short_pw = &pw[..16]; // 16 chars is enough for a password
        for env in &mut t.default_env {
            if env.contains("changeme") {
                *env = env.replace("changeme", short_pw);
            }
        }
        t.notes = t.notes.replace("changeme", short_pw);
    }
    templates
}

/// Path to user templates JSON file.
fn user_templates_path() -> std::path::PathBuf {
    let config_dir = dirs::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    config_dir.join("orca").join("templates.json")
}

/// Load user-defined templates from disk.
pub fn load_user_templates() -> Vec<AppTemplate> {
    let path = user_templates_path();
    if !path.exists() {
        return vec![];
    }
    match std::fs::read_to_string(&path) {
        Ok(data) => serde_json::from_str(&data).unwrap_or_default(),
        Err(_) => vec![],
    }
}

/// Save user-defined templates to disk.
pub fn save_user_templates(templates: &[AppTemplate]) -> anyhow::Result<()> {
    let path = user_templates_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let data = serde_json::to_string_pretty(templates)?;
    std::fs::write(&path, data)?;
    Ok(())
}

/// Path to cached community templates.
fn community_cache_path() -> std::path::PathBuf {
    let config_dir = dirs::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    config_dir.join("orca").join("community-templates.json")
}

/// Fetch community templates from the online catalog.
/// Cached locally for 1 hour. Falls back to cache if offline.
pub async fn fetch_community_templates() -> Vec<AppTemplate> {
    const CATALOG_URL: &str = "https://orca-desktop.com/templates.json";
    const CACHE_MAX_AGE_SECS: u64 = 3600; // 1 hour
    let cache_path = community_cache_path();

    // Check if cache is fresh enough
    let cache_fresh = cache_path.exists() && cache_path.metadata()
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.elapsed().ok())
        .map(|age: std::time::Duration| age.as_secs() < CACHE_MAX_AGE_SECS)
        .unwrap_or(false);

    if cache_fresh {
        if let Ok(data) = std::fs::read_to_string(&cache_path) {
            if let Ok(templates) = serde_json::from_str::<Vec<AppTemplate>>(&data) {
                return templates;
            }
        }
    }

    // Cache is stale or missing — fetch from the web
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    match client.get(CATALOG_URL).send().await {
        Ok(resp) if resp.status().is_success() => {
            if let Ok(body) = resp.text().await {
                if let Ok(templates) = serde_json::from_str::<Vec<AppTemplate>>(&body) {
                    let _ = std::fs::write(&cache_path, &body);
                    return templates;
                }
            }
        }
        _ => {}
    }

    // Fall back to stale cache
    if cache_path.exists() {
        if let Ok(data) = std::fs::read_to_string(&cache_path) {
            return serde_json::from_str(&data).unwrap_or_default();
        }
    }

    vec![]
}

/// Get all templates (builtins + community + user-defined).
pub fn all_templates() -> Vec<AppTemplate> {
    let mut templates = builtin_templates();
    // Community templates are loaded from cache (fetched async elsewhere)
    let cache_path = community_cache_path();
    if cache_path.exists() {
        if let Ok(data) = std::fs::read_to_string(&cache_path) {
            if let Ok(community) = serde_json::from_str::<Vec<AppTemplate>>(&data) {
                // Only add templates not already in builtins (by id)
                for t in community {
                    if !templates.iter().any(|b| b.id == t.id) {
                        templates.push(t);
                    }
                }
            }
        }
    }
    templates.extend(load_user_templates());
    templates
}
