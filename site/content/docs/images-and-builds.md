---
title: Images and builds
nav: Images & builds
description: Pull, build, inspect, scan, tag and prune images in Orca, add private registries, and track builds with history, comparisons and build targets.
---

This page covers the **Images** page, where you pull, build and manage images, and the **Builds** page, which keeps a history of every build and runs the build targets from your `orca.yaml` files.

## Pull an image

Click **Pull** on the **Images** page. Start typing to search Docker Hub: results show official images, download counts and stars. Click a result to pull it, or type a full reference such as `postgres:16` and click **Pull**.

The dialog shows the progress of each layer while the image downloads.

For a private registry, either save credentials once under **Settings** > **Registries** (see [Registries](#private-registries)), or click **Auth** in the pull dialog and enter a username and password for this pull only.

> [!TIP]
> The **Run Container** dialog also helps with tags: type a Docker Hub image name and it suggests the image's most recent tags. See [Containers](/docs/containers/#run-a-container).

## Build an image

Click **Build** on the **Images** page to open the build panel:

- **Context path (directory with Dockerfile)**: the build context, for example `/path/to/project`.
- **Dockerfile (optional)**: a Dockerfile name or path if it isn't `Dockerfile`.
- **Tag (optional)**: for example `myapp:latest`.
- **+ Add build arg** for `ARG` values.

Click **Build** to start. The build output streams into the panel, and the build is recorded on the [Builds page](#the-builds-page).

## Inspect an image

Click an image row to expand it. You see the image ID, tags, size, creation date and number of layers, and three actions:

- **View Layers** lists every layer with the Dockerfile instruction that created it and its size, so you can see what makes an image large.
- **Browse Files** opens the image's filesystem. Click folders to open them and files to view them.
- **Scan for Vulnerabilities** runs a Trivy scan (see below).

Each row also has buttons to run a container from the image, tag it, save it to a tar file and remove it. Select several rows with the checkboxes to delete them together.

## Scan for vulnerabilities

**Scan for Vulnerabilities** checks an image with [Trivy](https://trivy.dev). Orca runs Trivy in a container from `ghcr.io/aquasecurity/trivy:latest` and pulls that image on the first scan. You don't need to install anything.


The result shows how many vulnerabilities were found at each severity (critical, high, medium and low) and a table with the CVE, package, installed version, fixed version and title of each one.

Click **Export Report** to save the results as a self-contained HTML file named `vulnerability-report-<image>.html`, ready to share or attach to a ticket.

## Import, tag, save and prune

| Action | How |
|---|---|
| Import an image from a tar file | Click **Import** and enter the path to the tar file. |
| Save an image to a tar file | Click the save button on the image row and enter a **Save path**. |
| Tag an image | Click the tag button on the image row and enter a **Repository** and **Tag**, for example `myregistry.com/myapp` and `latest`. |
| Remove unused images | Click **Prune**. This removes dangling images and images no container uses. Images used by running or stopped containers are kept. |

Paths must be absolute.

You can do some of this from the terminal too:

```bash
orca images list
orca images pull nginx:alpine
orca images remove nginx:alpine
orca images prune
```

## Private registries

**Settings** > **Registries** stores credentials for private registries. Click **Add Registry**, pick a preset (**Docker Hub**, **GitHub**, **GitLab** or **AWS ECR**) or enter the **Server URL** yourself, then a **Display Name**, **Username** and **Password** (a password or access token).

When you pull an image from a registry with saved credentials, Orca uses them automatically.

## The Builds page

The **Builds** page lists builds with their status, tag, duration, start time and source. Use **All**, **In Progress**, **Success** and **Failed** to filter. The summary at the top shows the total number of builds, success rate, failures and average duration; open **Analytics** for builds per day over the last seven days and the most built images.

The source tells you where a build came from:

| Source | Meaning |
|---|---|
| **Manual** | Started from the Images page or from a build target. |
| **URL** | Started with **Build from URL**. |
| **Scheduled** | Started by a [scheduled build](#scheduled-builds). |
| **External** | Built outside Orca, read from BuildKit's build history (`docker buildx history`). |

### Build details and cache insights

Click a build to see its status, duration, context path, Dockerfile, image ID, build args and the full **Build Log**.

**Cache Insights** shows how many build steps came from the cache, for example "Cache: 8/10 steps cached (80%)". A low number on a build that should be cached usually means an early step, such as a `COPY` of the whole project, changes on every build.

### Debug a failed build with AI

When a build fails, the detail view shows the error and an **Ask AI** button. It opens Orca's AI assistant with a question already filled in: the image tag, the error and the last 50 lines of the build log, followed by "What went wrong and how can I fix it?". Send it as is or edit it first. The assistant uses the provider you set up under **Settings** > **AI & Agents**; see [AI assistant](/docs/ai-assistant/).

### Build from a URL

Click **Build from URL** and enter a **Source URL**: a Git repository such as `https://github.com/user/repo.git`, or the URL of a Dockerfile. Add an optional **Tag** and click **Build**.

### Compare two builds

Click **Compare**, select two builds and click **Compare Selected**. The comparison shows both builds side by side, with status, duration, start time, source and Dockerfile, and lists any build args that changed. **View Both Logs** shows the two build logs next to each other.

## Build targets

Build targets are images defined in a project's `orca.yaml` under `builds:`. Orca reads them from every `orca.yaml` it knows about: compose projects it can see, registered worktree projects and its own stacks folder.

```yaml title="orca.yaml"
builds:
  - name: web
    context: ./web
    dockerfile: Dockerfile    # the default
    tag: shop-web:dev
    args:
      NODE_VERSION: 22
```

Paths are relative to the folder with `orca.yaml`. You can also edit build targets as a form in the **Builds** tab of a stack's `orca.yaml` editor (see [Compose stacks](/docs/stacks/#orcayaml)).

The **Build Targets** section of the **Builds** page lists each target with its tag, context and Dockerfile. Click **Build** on one, or **Build All**.

See [builds in the orca.yaml reference](/docs/orca-yaml/#builds) for the full format.

### Scheduled builds

To rebuild an image on a schedule, for example every night to pick up base image updates, add a schedule under **Settings** > **Schedules** with the action **Build** and pick the **Build Target**. See [Scheduled actions](/docs/containers/#scheduled-actions) for the cron format.

## Related

- [Containers](/docs/containers/)
- [Compose stacks](/docs/stacks/)
- [orca.yaml reference](/docs/orca-yaml/)
