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
            icon: "PG".to_string(),
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
            icon: "MY".to_string(),
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
            icon: "RD".to_string(),
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
            icon: "MG".to_string(),
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
            icon: "NX".to_string(),
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
            icon: "CD".to_string(),
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
            icon: "GF".to_string(),
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
            icon: "PM".to_string(),
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
            icon: "IO".to_string(),
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
            icon: "PA".to_string(),
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
            icon: "AD".to_string(),
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
            icon: "MH".to_string(),
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
            icon: "PT".to_string(),
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
            icon: "GL".to_string(),
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
            icon: "GT".to_string(),
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
            icon: "RQ".to_string(),
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
            icon: "ES".to_string(),
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
            icon: "NT".to_string(),
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
            icon: "MS".to_string(),
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
            icon: "OC".to_string(),
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
            icon: "MB".to_string(),
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
            icon: "OL".to_string(),
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
            icon: "OW".to_string(),
            category: "AI".to_string(),
            image: "ghcr.io/open-webui/open-webui:main".to_string(),
            default_ports: vec!["3000:8080".to_string()],
            default_env: vec!["OLLAMA_BASE_URL=http://host.docker.internal:11434".to_string()],
            default_volumes: vec!["open-webui-data:/app/backend/data".to_string()],
            restart_policy: "unless-stopped".to_string(),
            is_builtin: false,
            notes: "Web UI at http://localhost:3000. Requires Ollama running (deploy it first from App Catalog). Create an account on first visit.".to_string(),
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

/// Get all templates (builtins + user-defined).
pub fn all_templates() -> Vec<AppTemplate> {
    let mut templates = builtin_templates();
    templates.extend(load_user_templates());
    templates
}
