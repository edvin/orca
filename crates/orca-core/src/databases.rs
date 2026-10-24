//! Shared databases: what a project needs (`requires:` in its `orca.yaml`),
//! what a workspace provides (`databases:` in its file), and the servers Orca
//! runs itself when neither has one.
//!
//! A project says which engine and version it needs; Orca gives it a database
//! of its own and a user of its own on a matching server, and writes the
//! connection into its `.env`. Commands run inside the server's container
//! and read its admin login from there, so Orca never handles it.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// Database engines Orca can give a project a database on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    Mysql,
    Mariadb,
    Postgres,
}

impl Engine {
    pub fn name(self) -> &'static str {
        match self {
            Engine::Mysql => "MySQL",
            Engine::Mariadb => "MariaDB",
            Engine::Postgres => "PostgreSQL",
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Engine::Mysql => "mysql",
            Engine::Mariadb => "mariadb",
            Engine::Postgres => "postgres",
        }
    }

    pub fn port(self) -> u16 {
        match self {
            Engine::Postgres => 5432,
            _ => 3306,
        }
    }

    /// Versions Orca runs itself, newest first: the first one a requirement
    /// accepts is used.
    pub fn versions(self) -> &'static [&'static str] {
        match self {
            Engine::Mysql => &["8.4", "8.0", "5.7"],
            Engine::Mariadb => &["11.4", "10.11", "10.6"],
            Engine::Postgres => &["17", "16", "15", "14", "13"],
        }
    }

    pub fn image(self, version: &str) -> String {
        format!("{}:{version}", self.id())
    }

    /// The longest user name the engine allows.
    fn max_user(self) -> usize {
        match self {
            Engine::Postgres => 63,
            _ => 32,
        }
    }

    /// Whether a server of `self` satisfies a requirement for `wanted`:
    /// MariaDB stands in for MySQL only when asked for by name.
    pub fn serves(self, wanted: Engine) -> bool {
        self == wanted
    }
}

/// `requires:` in a project's `orca.yaml`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct Requires {
    /// The database the project needs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub database: Option<DatabaseRequirement>,
    /// Several, for a project that needs more than one.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub databases: Vec<DatabaseRequirement>,
}

impl Requires {
    pub fn is_empty(&self) -> bool {
        self.database.is_none() && self.databases.is_empty()
    }

    pub fn all(&self) -> Vec<&DatabaseRequirement> {
        self.database.iter().chain(self.databases.iter()).collect()
    }
}

/// One database a project needs.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct DatabaseRequirement {
    pub engine: Engine,
    /// Versions it works with: `8`, `>=8.0`, `>=14, <18`. Any when unset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// The database's name; the project's name when unset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The project's own compose service this stands in for (its `db`), so
    /// it doesn't start when a shared server is used.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replaces: Option<String>,
    /// Variables to write into the project's `.env`, with `{host}`, `{port}`,
    /// `{name}`, `{user}`, `{password}` and `{url}` filled in.
    /// `DATABASE_URL: "{url}"` when unset.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    /// More than its own database: `create` lets it create and drop
    /// databases named `<name>_…`, for tests that make their own.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub privileges: Vec<Privilege>,
    /// A command run in the project folder after its database is created or
    /// reset, such as `php artisan migrate --seed`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Privilege {
    Create,
}

/// A server a workspace provides (`databases:` in its file).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct DatabaseServer {
    pub engine: Engine,
    /// Its service in the workspace's shared compose file.
    pub service: String,
    /// Its version, for matching requirements; read from the image when unset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

impl DatabaseRequirement {
    /// Everything that would make it fail later, said plainly.
    pub fn validate(&self) -> anyhow::Result<()> {
        if let Some(v) = &self.version {
            parse_constraints(v)?;
        }
        if let Some(n) = &self.name
            && !safe_name(n)
        {
            anyhow::bail!("database name '{n}': use lowercase letters, digits and _ (up to 63)");
        }
        for key in self.env.keys() {
            if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                anyhow::bail!("env: '{key}' is not a variable name");
            }
        }
        Ok(())
    }

    /// Whether a server of `engine` at `version` will do.
    pub fn accepts(&self, engine: Engine, version: Option<&str>) -> bool {
        if !engine.serves(self.engine) {
            return false;
        }
        match (&self.version, version) {
            (None, _) => true,
            // A server whose version isn't known is taken at its word.
            (Some(_), None) => true,
            (Some(want), Some(have)) => version_matches(want, have),
        }
    }

    /// The version Orca would run itself for this requirement.
    pub fn orca_version(&self) -> Option<&'static str> {
        self.engine
            .versions()
            .iter()
            .copied()
            .find(|v| self.version.as_deref().is_none_or(|want| version_matches(want, v)))
    }

    /// The variables for the project's `.env`.
    pub fn env_values(&self, c: &Connection) -> BTreeMap<String, String> {
        let templates: BTreeMap<String, String> = if self.env.is_empty() {
            BTreeMap::from([("DATABASE_URL".to_string(), "{url}".to_string())])
        } else {
            self.env.clone()
        };
        templates
            .into_iter()
            .map(|(k, t)| {
                let v = t
                    .replace("{host}", &c.host)
                    .replace("{port}", &c.port.to_string())
                    .replace("{name}", &c.database)
                    .replace("{user}", &c.user)
                    .replace("{password}", &c.password)
                    .replace("{url}", &c.url());
                (k, v)
            })
            .collect()
    }
}

/// How a project reaches its database.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Connection {
    pub engine: Engine,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    pub password: String,
}

impl Connection {
    pub fn url(&self) -> String {
        let scheme = match self.engine {
            Engine::Postgres => "postgresql",
            Engine::Mysql | Engine::Mariadb => "mysql",
        };
        format!(
            "{scheme}://{}:{}@{}:{}/{}",
            self.user, self.password, self.host, self.port, self.database
        )
    }
}

/// A database or user name made from a project's name: lowercase letters,
/// digits and `_`.
pub fn ident(raw: &str, max: usize) -> String {
    let mut s: String = raw
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    while s.contains("__") {
        s = s.replace("__", "_");
    }
    let s = s.trim_matches('_');
    let s = if s.is_empty() || s.starts_with(|c: char| c.is_ascii_digit()) {
        format!("db_{s}")
    } else {
        s.to_string()
    };
    s.chars()
        .take(max)
        .collect::<String>()
        .trim_end_matches('_')
        .to_string()
}

/// The user a project gets on a server of `engine`.
pub fn user_name(project: &str, engine: Engine) -> String {
    ident(project, engine.max_user())
}

pub fn safe_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 63
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
        && !name.starts_with(|c: char| c.is_ascii_digit())
}

/// Whether `have` (`8.4.3`, `17`) satisfies `want`: comma-separated
/// constraints, each `>=`, `>`, `<=`, `<`, `=`, `^` (same major), `~` (same
/// minor) or a bare version (that version and its patches: `8` is any 8.x).
pub fn version_matches(want: &str, have: &str) -> bool {
    let Ok(constraints) = parse_constraints(want) else {
        return false;
    };
    let have = parse_version(have);
    constraints.iter().all(|(op, v)| {
        let cmp = cmp_versions(&have, v);
        match op.as_str() {
            ">=" => cmp.is_ge(),
            ">" => cmp.is_gt(),
            "<=" => cmp.is_le() || prefix(&have, v),
            "<" => cmp.is_lt() && !prefix(&have, v),
            "^" => have.first() == v.first() && cmp.is_ge(),
            "~" => have.iter().take(2).eq(v.iter().take(2)) && cmp.is_ge(),
            _ => prefix(&have, v),
        }
    })
}

/// Whether `v` (as written, `8` or `8.4`) is a prefix of `have`.
fn prefix(have: &[u64], v: &[u64]) -> bool {
    have.len() >= v.len() && have.iter().zip(v).all(|(a, b)| a == b)
}

fn cmp_versions(a: &[u64], b: &[u64]) -> std::cmp::Ordering {
    let n = a.len().max(b.len());
    (0..n)
        .map(|i| a.get(i).copied().unwrap_or(0))
        .cmp((0..n).map(|i| b.get(i).copied().unwrap_or(0)))
}

fn parse_version(v: &str) -> Vec<u64> {
    v.trim()
        .trim_start_matches('v')
        .split(|c: char| !c.is_ascii_digit() && c != '.')
        .next()
        .unwrap_or("")
        .split('.')
        .filter_map(|p| p.parse().ok())
        .collect()
}

fn parse_constraints(want: &str) -> anyhow::Result<Vec<(String, Vec<u64>)>> {
    let mut out = Vec::new();
    for part in want.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        let op_len = part
            .find(|c: char| c.is_ascii_digit())
            .ok_or_else(|| anyhow::anyhow!("version '{want}': no version number in '{part}'"))?;
        let (op, v) = part.split_at(op_len);
        let op = op.trim();
        if !["", "=", ">=", ">", "<=", "<", "^", "~"].contains(&op) {
            anyhow::bail!("version '{want}': '{op}' isn't one of >=, >, <=, <, =, ^, ~");
        }
        let v = parse_version(v);
        if v.is_empty() {
            anyhow::bail!("version '{want}': '{part}' isn't a version");
        }
        out.push((op.to_string(), v));
    }
    if out.is_empty() {
        anyhow::bail!("version '{want}' is empty");
    }
    Ok(out)
}

/// The version in an image tag (`mysql:8.4.3`, `postgres:17-alpine`), if any.
pub fn image_version(image: &str) -> Option<String> {
    let tag = image.rsplit_once(':').map(|(_, t)| t)?;
    let v: String = tag.chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
    (!v.is_empty()).then_some(v)
}

// ---- Commands run inside the server's container ----

/// The admin client, logged in with the credentials the container was
/// started with.
const PG: &str = r#"psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d postgres"#;
const MY: &str =
    r#"$(command -v mysql || command -v mariadb) -uroot -p"${MYSQL_ROOT_PASSWORD:-$MARIADB_ROOT_PASSWORD}""#;
const PGDUMP: &str = r#"pg_dump -U "${POSTGRES_USER:-postgres}" --no-owner --no-acl"#;
const MYDUMP: &str = r#"$(command -v mysqldump || command -v mariadb-dump) -uroot -p"${MYSQL_ROOT_PASSWORD:-$MARIADB_ROOT_PASSWORD}" --single-transaction --routines --triggers"#;

fn check(name: &str) -> anyhow::Result<()> {
    if !safe_name(name) {
        anyhow::bail!("'{name}' is not a safe name for a database or user");
    }
    Ok(())
}

/// Passwords Orca generates are hex, so they need no quoting; anything else
/// is refused rather than escaped.
fn check_password(p: &str) -> anyhow::Result<()> {
    if p.is_empty() || !p.chars().all(|c| c.is_ascii_alphanumeric()) {
        anyhow::bail!("the database password must be letters and digits");
    }
    Ok(())
}

/// Create the database and its user if they don't exist, set the user's
/// password, and give it rights on its database (and with `create`, on
/// databases named `<db>_…`). Safe to run again.
pub fn provision_cmd(
    engine: Engine,
    db: &str,
    user: &str,
    password: &str,
    privileges: &[Privilege],
) -> anyhow::Result<String> {
    check(db)?;
    check(user)?;
    check_password(password)?;
    let create = privileges.contains(&Privilege::Create);
    Ok(match engine {
        Engine::Postgres => {
            let role = format!(
                "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '{user}') THEN CREATE ROLE \"{user}\" LOGIN; END IF; END $$; ALTER ROLE \"{user}\" WITH LOGIN PASSWORD '{password}' {};",
                if create { "CREATEDB" } else { "NOCREATEDB" }
            );
            format!(
                "{PG} -c \"$(cat <<'SQL'\n{role}\nSQL\n)\" && \
                 ({PG} -tAc \"SELECT 1 FROM pg_database WHERE datname='{db}'\" | grep -q 1 || {PG} -c 'CREATE DATABASE \"{db}\" OWNER \"{user}\"') && \
                 {PG} -c 'ALTER DATABASE \"{db}\" OWNER TO \"{user}\"'"
            )
        }
        Engine::Mysql | Engine::Mariadb => {
            let mut sql = format!(
                "CREATE DATABASE IF NOT EXISTS `{db}`; CREATE USER IF NOT EXISTS '{user}'@'%' IDENTIFIED BY '{password}'; ALTER USER '{user}'@'%' IDENTIFIED BY '{password}'; GRANT ALL PRIVILEGES ON `{db}`.* TO '{user}'@'%';"
            );
            if create {
                // `\_` is a literal underscore in a grant's database pattern.
                sql.push_str(&format!(
                    " GRANT ALL PRIVILEGES ON `{}\\_%`.* TO '{user}'@'%';",
                    db.replace('_', "\\_")
                ));
            }
            sql.push_str(" FLUSH PRIVILEGES;");
            format!("{MY} -e \"$(cat <<'SQL'\n{sql}\nSQL\n)\"")
        }
    })
}

/// Drop the database and create it again, empty, for its user.
pub fn reset_cmd(engine: Engine, db: &str, user: &str) -> anyhow::Result<String> {
    check(db)?;
    check(user)?;
    Ok(match engine {
        Engine::Postgres => format!(
            "{PG} -c 'DROP DATABASE IF EXISTS \"{db}\" WITH (FORCE)' && {PG} -c 'CREATE DATABASE \"{db}\" OWNER \"{user}\"'"
        ),
        Engine::Mysql | Engine::Mariadb => format!("{MY} -e 'DROP DATABASE IF EXISTS `{db}`; CREATE DATABASE `{db}`;'"),
    })
}

/// Drop a database and, when no other database is left for it, its user.
pub fn drop_cmd(engine: Engine, db: &str) -> anyhow::Result<String> {
    check(db)?;
    Ok(match engine {
        Engine::Postgres => format!("{PG} -c 'DROP DATABASE IF EXISTS \"{db}\" WITH (FORCE)'"),
        Engine::Mysql | Engine::Mariadb => format!("{MY} -e 'DROP DATABASE IF EXISTS `{db}`'"),
    })
}

/// Print `name<TAB>bytes` for every database that isn't the server's own.
pub fn list_cmd(engine: Engine) -> String {
    match engine {
        Engine::Postgres => format!(
            "{PG} -tAF '\t' -c \"SELECT datname, pg_database_size(datname) FROM pg_database WHERE datistemplate = false AND datname <> 'postgres' ORDER BY 1\""
        ),
        Engine::Mysql | Engine::Mariadb => format!(
            "{MY} -N -B -e \"SELECT s.schema_name, COALESCE(SUM(t.data_length + t.index_length), 0) FROM information_schema.schemata s LEFT JOIN information_schema.tables t ON t.table_schema = s.schema_name WHERE s.schema_name NOT IN ('mysql','information_schema','performance_schema','sys') GROUP BY s.schema_name ORDER BY 1\""
        ),
    }
}

/// Write the database as SQL to stdout.
pub fn dump_cmd(engine: Engine, db: &str) -> anyhow::Result<String> {
    check(db)?;
    Ok(match engine {
        Engine::Postgres => format!("{PGDUMP} -d \"{db}\""),
        Engine::Mysql | Engine::Mariadb => format!("{MYDUMP} \"{db}\""),
    })
}

/// Read SQL from stdin into the database.
pub fn restore_cmd(engine: Engine, db: &str) -> anyhow::Result<String> {
    check(db)?;
    Ok(match engine {
        Engine::Postgres => format!(r#"psql -v ON_ERROR_STOP=1 -q -U "${{POSTGRES_USER:-postgres}}" -d "{db}""#),
        Engine::Mysql | Engine::Mariadb => format!("{MY} \"{db}\""),
    })
}

/// The admin login an Orca-run server starts with, as container environment.
pub fn server_env(engine: Engine, root_password: &str) -> Vec<(String, String)> {
    match engine {
        Engine::Postgres => vec![
            ("POSTGRES_USER".into(), "postgres".into()),
            ("POSTGRES_PASSWORD".into(), root_password.into()),
        ],
        Engine::Mysql => vec![("MYSQL_ROOT_PASSWORD".into(), root_password.into())],
        Engine::Mariadb => vec![("MARIADB_ROOT_PASSWORD".into(), root_password.into())],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(engine: Engine, version: Option<&str>) -> DatabaseRequirement {
        DatabaseRequirement {
            engine,
            version: version.map(Into::into),
            name: None,
            replaces: None,
            env: BTreeMap::new(),
            privileges: vec![],
            seed: None,
        }
    }

    #[test]
    fn versions_match_like_people_write_them() {
        assert!(version_matches("8", "8.4.3"));
        assert!(!version_matches("8", "9.0"));
        assert!(version_matches(">=8.0", "8.4"));
        assert!(!version_matches(">=8.0", "5.7"));
        assert!(version_matches(">=14, <18", "17"));
        assert!(!version_matches(">=14, <18", "18.1"));
        assert!(version_matches("<9", "8.4"));
        assert!(!version_matches("<8", "8.4"), "a bare 8 includes 8.4");
        assert!(version_matches("<=8", "8.4"));
        assert!(version_matches("^8.0", "8.4"));
        assert!(!version_matches("^8.0", "9.0"));
        assert!(version_matches("~10.6", "10.6.18"));
        assert!(!version_matches("~10.6", "10.11"));
        assert!(version_matches("=17", "17.2"));
        assert!(!version_matches("nonsense", "17"));
    }

    #[test]
    fn orca_picks_the_newest_version_a_project_accepts() {
        assert_eq!(req(Engine::Mysql, None).orca_version(), Some("8.4"));
        assert_eq!(req(Engine::Mysql, Some("5.7")).orca_version(), Some("5.7"));
        assert_eq!(req(Engine::Postgres, Some("<17")).orca_version(), Some("16"));
        assert_eq!(req(Engine::Mysql, Some(">=9")).orca_version(), None);
    }

    #[test]
    fn servers_match_engine_and_version() {
        let r = req(Engine::Mysql, Some(">=8.0"));
        assert!(r.accepts(Engine::Mysql, Some("8.4")));
        assert!(!r.accepts(Engine::Mysql, Some("5.7")));
        assert!(!r.accepts(Engine::Mariadb, Some("11.4")), "MariaDB only when asked for");
        assert!(
            r.accepts(Engine::Mysql, None),
            "an unknown version is taken at its word"
        );
    }

    #[test]
    fn names_are_safe_and_short_enough() {
        assert_eq!(ident("oneWebshop-backend", 63), "onewebshop_backend");
        assert_eq!(ident("2fa--service", 63), "db_2fa_service");
        let long = user_name("a-really-long-project-name-that-goes-on-and-on", Engine::Mysql);
        assert!(long.len() <= 32 && !long.ends_with('_'), "{long}");
        assert!(safe_name("onecrm") && !safe_name("one-crm") && !safe_name("1db"));
    }

    #[test]
    fn env_is_filled_in() {
        let c = Connection {
            engine: Engine::Mysql,
            host: "mysql".into(),
            port: 3306,
            database: "onecrm".into(),
            user: "onecrm".into(),
            password: "s3cret".into(),
        };
        let mut r = req(Engine::Mysql, None);
        assert_eq!(
            r.env_values(&c)["DATABASE_URL"],
            "mysql://onecrm:s3cret@mysql:3306/onecrm"
        );
        r.env = BTreeMap::from([
            ("DB_HOST".into(), "{host}".into()),
            ("DB_PASSWORD".into(), "{password}".into()),
        ]);
        let env = r.env_values(&c);
        assert_eq!(
            (env["DB_HOST"].as_str(), env["DB_PASSWORD"].as_str()),
            ("mysql", "s3cret")
        );
        assert!(!env.contains_key("DATABASE_URL"));
    }

    #[test]
    fn commands_refuse_unsafe_names() {
        assert!(provision_cmd(Engine::Mysql, "a`b", "u", "p", &[]).is_err());
        assert!(provision_cmd(Engine::Postgres, "db", "u'x", "p", &[]).is_err());
        assert!(provision_cmd(Engine::Mysql, "db", "u", "pass word", &[]).is_err());
        let my = provision_cmd(Engine::Mysql, "onecrm", "onecrm", "abc123", &[Privilege::Create]).unwrap();
        assert!(my.contains("CREATE USER IF NOT EXISTS 'onecrm'@'%'") && my.contains(r"`onecrm\_%`.*"));
        let pg = provision_cmd(Engine::Postgres, "onecrm", "onecrm", "abc123", &[]).unwrap();
        assert!(pg.contains("CREATE DATABASE \"onecrm\" OWNER \"onecrm\"") && pg.contains("NOCREATEDB"));
    }

    #[test]
    fn requires_parses_one_or_several() {
        let r: Requires =
            serde_yaml::from_str("database:\n  engine: mysql\n  version: \">=8.0\"\n  replaces: db\n").unwrap();
        assert_eq!(r.all().len(), 1);
        assert_eq!(r.all()[0].replaces.as_deref(), Some("db"));
        let r: Requires =
            serde_yaml::from_str("databases:\n  - engine: postgres\n  - engine: mysql\n    name: legacy\n").unwrap();
        assert_eq!(r.all().len(), 2);
        assert!(serde_yaml::from_str::<Requires>("database:\n  engine: oracle\n").is_err());
        assert!(
            image_version("mysql:8.4.3") == Some("8.4.3".into())
                && image_version("postgres:17-alpine") == Some("17".into())
        );
        assert_eq!(image_version("postgres:latest"), None);
    }
}
