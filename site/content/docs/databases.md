---
title: Databases
nav: Databases
description: Projects say which database they need in orca.yaml; Orca gives each one a database and a user of its own, on a shared server or its own.
---

A project can say in its `orca.yaml` which database it needs, such as "MySQL 8 or newer". Orca then gives it a database and a user of its own on a matching server, writes the connection into the project's `.env`, and can keep the project's own database container from starting. Your team can share one server per engine through its [workspace](/docs/workspaces/), and on a machine without one, Orca runs the server itself.

This page is for you when you want fewer database containers on your machine, the same database setup for everyone on a team, or snapshots and resets without remembering `mysqldump` flags.

## How it works

A project's database comes from the first of these that fits:

1. **The workspace's server**, when your workspace shares one for that engine and its version is one the project accepts.
2. **The project's own database service**, when it has one (`replaces:`) and the workspace has no matching server. This is how the project runs without Orca, so nothing changes.
3. **A server Orca runs itself**, when there's neither. Orca runs one server per engine and version, such as MySQL 8.4 or PostgreSQL 17, started the first time a project needs it.

Once a database exists, it stays on its server: when your team adds a shared server later, a project whose database Orca already made elsewhere keeps using it, so no data is left behind. The workspace file can move a project explicitly with [`database:`](#choose-per-project-in-the-workspace).

On the chosen server, Orca:

- creates a database named after the project (`onecrm`), and a **user of its own** with a generated password, allowed into that database only;
- writes the connection into the project's `.env`;
- with `replaces:`, keeps the project's own database service from starting, and sets the connection on the services that depended on it.

Orca does this every time the project starts, so a missing database or user is made again, and it's safe to repeat. A [workspace](/docs/workspaces/) project gets it during setup, in the **Create its database** step, before its setup command runs, so migrations in that command find their database.

## Require a database

Add `requires:` to the project's `orca.yaml`:

```yaml title="orca.yaml"
requires:
  database:
    engine: mysql
    version: ">=8.0"
    replaces: db
    env:
      DB_HOST: "{host}"
      DB_PORT: "{port}"
      DB_DATABASE: "{name}"
      DB_USERNAME: "{user}"
      DB_PASSWORD: "{password}"
```

| Key | Default | Meaning |
|---|---|---|
| `engine` | required | `mysql`, `mariadb` or `postgres`. A MariaDB server is only used for `engine: mariadb`. |
| `version` | any | The versions the project works with: `8` (any 8.x), `>=8.0`, `>=14, <18`, `^8.0` (same major), `~10.6` (same minor). Separate several with commas. |
| `name` | the project's name | The database's name: lowercase letters, digits and `_`. |
| `replaces` | none | The project's own compose service that this database stands in for, usually `db`. |
| `env` | `DATABASE_URL: "{url}"` | The variables to write into `.env`, with placeholders filled in (see below). |
| `privileges` | none | `[create]` lets the project's user create and drop databases named `<name>_…`, for test suites that make their own. |
| `seed` | none | A command run in the project's folder after its database is reset, such as `php artisan migrate --seed`. |

A project that needs more than one database lists them under `databases:` instead of `database:`, each with the same keys.

The placeholders in `env`:

| Placeholder | Becomes |
|---|---|
| `{host}` | The server's name on the project's network, such as `orca-mysql-8-4` or `acme-shared-mysql-1`. |
| `{port}` | `3306` for MySQL and MariaDB, `5432` for PostgreSQL. |
| `{name}` | The database. |
| `{user}` | The project's user. |
| `{password}` | Its generated password. |
| `{url}` | All of them as a URL: `mysql://user:password@host:3306/name` or `postgresql://…`. |

> [!NOTE]
> The app has to read these values: from `.env` (`env_file: .env`, a mounted `.env`, or `${DB_HOST}` in the compose file). With `replaces:`, Orca also sets them directly on the services that depended on the replaced one, so a compose file that hardcodes `DATABASE_URL` works too.

If `requires:` has a mistake, Orca leaves it out and says why on the stack's **orca.yaml** tab, rather than breaking the rest of the file.

## Shared servers in a workspace

A [workspace](/docs/workspaces/) shares a server by naming a service of its shared compose file under `databases:`:

```yaml title="orca-workspace.yaml"
shared:
  compose: compose.yaml

databases:
  mysql:
    engine: mysql
    service: mysql
    version: "8.4"
  postgres:
    engine: postgres
    service: postgres
```

```yaml title="compose.yaml (the workspace's shared services)"
services:
  mysql:
    image: mysql:8.4
    environment:
      MYSQL_ROOT_PASSWORD: ${MYSQL_ROOT_PASSWORD:-root}
  postgres:
    image: postgres:17
    environment:
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-postgres}
```

| Key | Meaning |
|---|---|
| `engine` | `mysql`, `mariadb` or `postgres`. |
| `service` | The service in the shared compose file. |
| `version` | Its version, for matching projects' `version:`. When left out, Orca reads it from the running image's tag. |

The server starts the first time a project needs it, like any shared service. Orca runs its commands inside the server's container and reads the admin login from the container's own environment (`MYSQL_ROOT_PASSWORD`, `MARIADB_ROOT_PASSWORD`, or `POSTGRES_USER` and `POSTGRES_PASSWORD`), so it never needs to be told the admin password. Set one of those on a shared server: Orca needs the admin login to create databases and users, so a server started with `MYSQL_RANDOM_ROOT_PASSWORD` can't be shared.

When a project starts, the servers it uses join its networks, so its services reach them by name whatever networks the project uses.

### Choose per project in the workspace

A workspace project can override where its database comes from with `database:`:

```yaml title="orca-workspace.yaml"
projects:
  onecrm:
    repo: git@git.acme.dev:crm/onecrm.git
    database: mysql      # this server, by its name under databases:
  legacy-shop:
    repo: git@git.acme.dev:shop/legacy.git
    database: own        # its own database service, even though one is shared
```

Use it to move a project onto a shared server (snapshot its database first, then restore the snapshot there), or to keep one on its own database while it isn't ready to share.

## Servers Orca runs

With no workspace server and no database of its own, the project gets one of Orca's servers. Orca picks the newest version the project accepts from the ones it runs:

| Engine | Versions |
|---|---|
| MySQL | 8.4, 8.0, 5.7 |
| MariaDB | 11.4, 10.11, 10.6 |
| PostgreSQL | 17, 16, 15, 14, 13 |

Each runs in a container named after it, such as `orca-mysql-8-4`, with its data in a volume (`orca-mysql-8-4-data`) and a port on this computer for database tools: 13306 and up for MySQL and MariaDB, 15432 and up for PostgreSQL. Orca generates its admin password and keeps it in its settings on this computer. The server restarts with your machine and is listed on the **Databases** page, where you can stop and start it.

## The Databases page

**Databases** in the sidebar shows:

- **Projects**: every project whose `orca.yaml` requires a database, and where each one comes from, or why it can't be provided (for example *"needs MySQL >=9.0; no server for it is available"*).
- **Servers**: each server, whether it's the workspace's or **Run by Orca**, whether it runs, its name inside containers and its port on this computer, and **Open phpMyAdmin** or **Open pgAdmin** (or Adminer) when your gateway routes one. Below it, every database on it with its project, user and size.

For each database:

- **Connect** shows the host, port, database, user and password, and a URL for database tools such as TablePlus, DBeaver or DataGrip, each with a copy button. The password stays hidden until you click **Show**.
- **Snapshot** saves a compressed SQL dump on this computer. **Restore** lists the snapshots, takes a new one with an optional label such as `before-migration`, and restores or deletes one.
- **Reset** empties the database and runs the project's `seed` command, when it has one.

A project's database also shows on its stack page, above its services, and on its card on the **Workspace** page. The dashboard counts databases and servers once there are any.

### Snapshots

Snapshots are `.sql.gz` files in Orca's data folder on this computer: `~/Library/Application Support/orca/database-snapshots` on macOS, `~/.local/share/orca/database-snapshots` on Linux. Restoring one empties the database first, then loads the snapshot; on PostgreSQL the tables belong to the project's user again afterwards. Each database's snapshots are in a folder of their own, such as `database-snapshots/workspace-mysql/onecrm`; copy one into the same folder on a colleague's computer, and they can restore it there.

## Move a project onto a shared server

A project that runs its own database today keeps its data in that container's volume. Moving it takes five steps. The **Databases** page lists every project's own database container under **Projects' own database containers**, which is where to start.

1. **Give the workspace a server** for the project's engine, if it has none yet: a service in the shared compose file and an entry under [`databases:`](#shared-servers-in-a-workspace). Click **Update** on the **Workspace** page.
2. **Require the database** in the project's `orca.yaml`, with `replaces:` naming its own database service, and `env:` in the variable names the app reads. A WordPress site that has `WORDPRESS_DB_HOST` and friends in its compose file:

   ```yaml title="orca.yaml"
   requires:
     database:
       engine: mysql
       name: wordpress
       replaces: db
       env:
         WORDPRESS_DB_HOST: "{host}"
         WORDPRESS_DB_NAME: "{name}"
         WORDPRESS_DB_USER: "{user}"
         WORDPRESS_DB_PASSWORD: "{password}"
   ```

3. **Start the project** from Orca. It now gets an empty database on the shared server, and its own database container no longer starts.
4. **Copy its data over.** On the **Databases** page, its row under **Projects' own database containers** now has **Import into wordpress**. Orca takes a snapshot of the new database first, starts the old container for the copy if it's stopped, copies the data in, and stops the old container again.
5. **Check the app**, then remove the old container and its volume when you're sure you won't need them. Until then, they're your way back.

The copy streams straight from one container into the other, so even a large database never sits in memory or on disk on the way.

**Between MariaDB and MySQL**, the copy is translated on the way: MariaDB 11's `utf8mb4_uca1400_…` collations become MySQL's `utf8mb4_0900_ai_ci`, and the first line MariaDB's dumps start with, which MySQL rejects, is left out. Going the other way, MySQL 8's `utf8mb4_0900_…` collations become `utf8mb4_unicode_520_ci`. PostgreSQL copies into PostgreSQL only.

**A container with a random admin password**, such as one started with `MARIADB_RANDOM_ROOT_PASSWORD`, is read with the app's own user instead (`MYSQL_USER` or `MARIADB_USER`, with its password), which can read its own database.

### Ask an AI tool to do it

With Orca [connected to your AI tool](/docs/agents/), you can ask for the whole move in a sentence:

> We want one shared MySQL and one shared Postgres for the whole team instead of every app running its own database. Consolidate our apps' databases into shared databases defined in the workspace, and move their data over.

The AI tool reads this page through Orca (`orca_docs`), lists every project's own database containers (`find_database_services`), and looks at their compose files and data. It then proposes a plan for you to approve before it changes anything. In our test it noticed on its own that a WordPress site ran on MariaDB 11 while the team asked for MySQL, and asked which to use. Once you say go ahead, it:

1. adds the servers to the workspace's compose file and `databases:`, and applies the workspace;
2. writes `requires:` into each project's `orca.yaml`, mapping each app's own variable names;
3. restarts each project, so it gets its database on the shared server;
4. copies each database over with `database_import`, which snapshots first;
5. compares tables and rows on both sides, and checks the apps still answer.

It edits the workspace repo on your machine; your teammates get the shared servers once you commit and push it. Copying over data needs your approval in clients that ask before destructive tools.

## Users and passwords

Every project gets its own user on each server, named after the project and allowed into its own databases only. Its password is generated the first time, kept in Orca's settings on this computer, written into the project's `.env`, and never committed. Another project can't read or change it.

Orca's admin access is used only to create databases and users and to reset or restore them. It's never written into a project.

## AI tools

AI tools connected to Orca can use these tools. See [AI tools](/docs/agents/):

| Tool | What it does |
|---|---|
| `list_databases` | The servers, the databases on them with their project and size, and what each project requires. No passwords. |
| `database_connection` | Host, port, database and user; the password is left out (it's in the project's `.env`). |
| `database_snapshot` | Save a snapshot, for example before a migration. |
| `database_restore` | Restore a snapshot. Your AI tool asks you first. |
| `database_reset` | Empty a database and run its seed command. Your AI tool asks you first. |
| `find_database_services` | Every project's own MySQL, MariaDB and PostgreSQL containers, with engine, version, the database in them and their volumes. |
| `database_import` | Copy a project's own database into its database on a shared server, after a snapshot. Your AI tool asks you first. |
| `orca_docs` | This documentation, so the AI tool reads the exact keys rather than guessing them. |

So you can ask *"snapshot onecrm's database, then run the migration"*, *"that went wrong, restore it"*, or for a [whole move onto shared servers](#ask-an-ai-tool-to-do-it).

## Troubleshooting

**The app can't reach its database.** Check that the app reads the connection from `.env`, or uses `replaces:` so Orca sets it on the service. The host is the server's container name, which works on any of the project's networks once the project has started through Orca.

**A project still starts its own database.** Without `replaces:`, Orca doesn't know which service is the database; add `replaces: db`. With it, the project uses its own service when the workspace has no matching server: check the **Projects** list on the **Databases** page for where its database comes from.

**An import fails with "Unknown collation" or "Unknown command '\-'".** These come from copying between MariaDB and MySQL with an older Orca, which didn't translate the dump. Update Orca and import again.

**"needs MySQL >=9.0; no server for it is available".** No server matches the `version:`. Widen it, or add a server of that version to the workspace.

**MySQL 8 logins fail with `caching_sha2_password`.** Some clients, such as MariaDB's `mysql` command-line client in Alpine images and very old PHP drivers, can't use MySQL 8's default login method, which Orca's users have. Use MySQL's own client or a current driver (PHP's `mysqlnd`, Node's `mysql2` and JDBC all support it).

## Related

- [orca.yaml reference](/docs/orca-yaml/#requires-databases)
- [Workspace file reference](/docs/workspaces-reference/#databases)
- [Worktree instances](/docs/worktrees/), which give each worktree its own database on a shared server
