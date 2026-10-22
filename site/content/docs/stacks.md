---
title: Compose stacks
nav: Stacks
description: How Orca finds Docker Compose projects, and how to start, stop, edit and create compose stacks, switch profiles and set up orca.yaml.
---

A stack is a Docker Compose project. Orca shows every compose project on the machine as a stack, whether you started it from Orca or from a terminal, and gives it a page with its services, logs, compose file and `orca.yaml`.

## How stacks are found

Docker Compose labels every container it creates with the project name, its working directory and its compose files. Orca groups containers by these labels, so any project you start with `docker compose up` shows up as a stack without extra setup. A project started from several compose files (`docker compose -f compose.yaml -f compose.dev.yaml up`) works the same way: Orca passes every file to Compose for every command it runs on the stack.

Stacks appear as cards at the top of the **Containers** page. Each card shows the stack's services and lets you start, stop, restart, pull or delete the stack. Click the stack name to open its page.

The stack status is **Running** when all services run, **Partial** when only some do, and **Stopped** when none do.

## The stack page

The header shows the stack's working directory (**Copy path** copies it), how many services are running, and the stack actions. Below are four tabs: **Services**, **Logs**, **Compose File** and **orca.yaml**.

### Start, stop, restart and pull

| Button | What it does |
|---|---|
| **Start** | Runs `docker compose up` for the stack, then any [setup commands](#setup-commands) from its `orca.yaml`. Shown when the stack is not fully running. |
| **Stop** | Runs `docker compose down` after a confirmation. This stops and removes the stack's containers. Named volumes are kept. |
| **Restart** | Stops and starts the stack's existing containers. |
| **Pull** | Runs `docker compose pull` to fetch newer images. |

**Restart**, **Pull** and **Start** need the stack's working directory, which Compose records when it creates the containers.

> [!TIP]
> **Restart** reuses the existing containers. To pick up new images after **Pull**, use **Stop** and then **Start** so Compose recreates the containers. For changes to the compose file, use **Apply changes** on the [Compose File](#compose-file) tab.

### Services

**Services** lists each service with its container name, image, state and ports. Each row has **Logs**, and **Start**, **Stop** or **Restart** for that service alone. Click a row to open the container's detail page (see [Containers](/docs/containers/)).

If the compose file uses profiles, services whose profile is off are listed too, marked **Off**, with a button to turn their profile on.

### Logs

**Logs** shows the output of one service at a time. Pick the service from the row of buttons at the top. The log viewer has the same filter, regex and case-sensitive options as on a container's page.

### Compose File

**Compose File** opens the stack's compose file in an editor, with its path above it. If the stack was started from several compose files, a picker above the editor switches between them. The editor works wherever the project lives, and for stacks on a [remote host](/docs/remote-hosts/) it edits the files on that host.

Click **Apply Changes** (or press Ctrl+S, Cmd+S on macOS) to save. Orca checks that the file is valid YAML and doesn't save it otherwise. After a save, a banner offers **Apply changes**: it runs `docker compose up`, which recreates the services whose definition changed and leaves the others running, then runs the stack's [setup commands](#setup-commands).

### orca.yaml

The **orca.yaml** tab edits the stack's `orca.yaml`, see [below](#orcayaml).

## Create a new stack

There are two ways to create a compose project from Orca. Both save the compose file in Orca's stacks folder and then run `docker compose up`. The project is named after its folder.

**Write the compose file yourself.** Click **Compose** on the **Containers** page to open **Deploy Compose Stack**. Enter a **Directory Path** inside the stacks folder, edit the YAML, and click **Deploy**. Click **Validate** first if you want a check: Orca runs `docker compose config` on the file and shows any errors.

**Use the wizard.** Open the command palette (Ctrl+K, Cmd+K on macOS) and run **Compose: Create New Stack**. The wizard has three steps:

1. **Name**: the stack name.
2. **Services**: add services with an image (with Docker Hub search), ports, environment variables, volumes, **Depends On** and a restart policy.
3. **Review & Deploy**: check and edit the generated YAML, then click **Deploy**, or **Save Only** to write the file without starting it.

To deploy a ready-made app instead, use the [App Catalog](/docs/templates/).

## Profiles

Compose profiles mark services as optional, such as an admin UI or a mail catcher. When a stack's compose file has profiles, the **Services** tab shows a **Profiles** panel with a card for each profile.

Turn profiles on or off, check what will start and stop, and click **Apply** (or **Save** when the stack is stopped). Orca remembers the choice on this machine and starts the same set every time it starts the stack. If a service you turned on depends on a service in another profile, Orca tells you and offers to turn that profile on too.

![A stack page with its compose profiles as cards above the services](/assets/screens/stack-profiles.webp)

See [Compose profiles](/docs/profiles/) for the details.

## Setup commands

An `orca.yaml` next to the compose file can list commands to run inside a service after the stack starts, such as database migrations. Orca runs them in order with `sh -c` after every start from Orca. If one fails, Orca reports it and still runs the rest; the output is in **Activity**.

Because they run on every start, make them safe to repeat, for example with `--force`, `|| true` or `IF NOT EXISTS`. See [orca.yaml hooks](/docs/orca-yaml/#hooks).

## orca.yaml

An `orca.yaml` in the same folder as the compose file gives the stack HTTPS hostnames through the gateway, links to its other environments, build targets and setup commands. Orca reads it whenever the stack runs, however it was started, so you can commit it and share the setup with your team.

![The orca.yaml tab: routes as forms, with the stack's services and ports to pick from](/assets/screens/orca-yaml-editor.webp)

The **orca.yaml** tab shows the file's path and a **orca.yaml reference** button. If the stack has no `orca.yaml` yet, click **Create orca.yaml** to start from the stack's running services. Nothing is written until you save.

The editor has a tab for each section, with forms instead of raw YAML:

| Tab | What you edit |
|---|---|
| **Routes** | Gateway hostnames: a hostname, a service, a port and an optional path. Each route shows its current state, such as **Active**, **Waiting** or **Not applied**. |
| **Links** | Groups of links to the app in other environments, such as `local` and `staging`. |
| **Setup commands** | Commands to run in a service after every start. |
| **Builds** | Images to build from this project: name, context, Dockerfile, tag and build args. They appear on the **Builds** page. |
| **YAML** | The file itself, with autocompletion. |

The status next to the tabs says whether the file is **Valid** or points to the line with an error. Click **Save** to write the file; Orca applies the changes right away.

If an `orca.local.yaml` overrides some values on this machine, the tab says so. A `dev:` section for worktree instances is kept as is; edit it on the **Projects** page.

See the [orca.yaml reference](/docs/orca-yaml/) for every key.

## Related

- [Containers](/docs/containers/)
- [Compose profiles](/docs/profiles/)
- [orca.yaml reference](/docs/orca-yaml/)
- [App Catalog and templates](/docs/templates/)
