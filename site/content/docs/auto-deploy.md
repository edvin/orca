---
title: Push to deploy
nav: Push to deploy
description: Redeploy containers automatically when GitHub or Docker Hub publishes a new image, using deploy rules and signed webhooks.
---

Push to deploy lets a registry tell the Orca daemon that a new image exists. The daemon pulls it and recreates the matching containers with the new image. Use it on a server running `orca-daemon` so that a `git push` ends with the new version running, with no SSH step in between.

## How it works

1. Your CI pipeline builds an image and pushes it to a registry.
2. The registry sends a webhook to the daemon.
3. The daemon checks the signature, reads the image name and tag, and looks for deploy rules that match.
4. For each matching rule, it pulls `image:tag` in the background, then stops, removes and recreates each target container with the new image.

The webhook endpoints are:

| Source | Endpoint | Authentication |
|---|---|---|
| GitHub | `POST /api/v1/webhooks/github` | HMAC-SHA256 signature in `X-Hub-Signature-256` |
| Docker Hub | `POST /api/v1/webhooks/dockerhub` | Shared secret as `?token=<secret>` in the URL, or in an `X-Orca-Webhook-Token` header |

These two paths are the only API routes that don't need the API token. They authenticate with the webhook secret instead.

> [!NOTE]
> The registry has to reach the daemon over the network. A local daemon listens on `127.0.0.1` only, so push to deploy is meant for a [remote host](/docs/remote-hosts/) behind an HTTPS reverse proxy, for example `https://orca.example.com/api/v1/webhooks/github`.

## Set the webhook secret

Open **Settings**, then the **Auto-deploy** tab. **Auto-deploy on new image…** in a container's **More actions** menu on the **Containers** page opens the same tab. Settings apply to the host that is currently selected, so switch to the server first.

Click **Generate** next to **Webhook secret** to fill in a random secret and copy it to the clipboard, or enter your own long random value. Then click **Save**. You'll paste the same value into GitHub, or into the Docker Hub webhook URL.

The secret is required: the daemon rejects every webhook until one is set. A GitHub request without a valid signature fails with `webhook rejected: invalid or missing signature`.

The secret in **Settings** is the global secret, and a webhook that proves it can trigger every rule. A rule can also have its own secret, which only triggers that rule. The app has no field for per-rule secrets; set one with the `webhook_secret` field of `POST /api/v1/deploy/rules` (see the [REST API](/docs/api/)).

The secret is stored in the daemon's `config.json` and is never sent back to the app, so the field stays empty when you return to the tab.

## Create a deploy rule

On the **Auto-deploy** tab, click **Add rule** and fill in the form:

| Field | What it does |
|---|---|
| **Rule name** | A label shown in the rules table and deploy history. |
| **Image pattern** | The image name without a tag, for example `ghcr.io/myorg/api`. |
| **Tag filter** | Which pushed tags trigger a deploy, as one filter or a comma-separated list. See below. |
| **Container names** | Comma-separated container names to recreate, for example `api, worker`. Leave empty to recreate every container whose image contains the pattern. |
| **Enabled** | Turn off to pause the rule without deleting it. |

Click **Save**. The rule appears in the table with its status, **Active** or **Paused**, and you can edit or delete it from the **Actions** column.

### Image matching

The image from the webhook must equal **Image pattern**, or equal it once the registry host is removed. `myorg/api` and `ghcr.io/myorg/api` both match an image pushed as `ghcr.io/myorg/api`. A partial name such as `api` does not.

### Tag filters

A tag filter is one pattern or a comma-separated list of them, such as `latest, v*`. The rule deploys when the tag matches any of them:

| Filter | Matches |
|---|---|
| empty or `*` | Any tag |
| `v*` | Tags starting with `v`, such as `v1.0` and `v2.3.1` |
| `latest` | Only `latest` |
| `main` | Only the tag `main` |

A pattern ending in `*` is a prefix match. Anything else must match the tag exactly.

### Test a rule

Under the webhook URL, enter an image and a tag and click **Test**. Orca shows which rules would deploy, without pulling or touching any container.

## Connect GitHub

GitHub sends a **Packages** event when a new container image version is published to `ghcr.io`.

1. On the **Auto-deploy** tab, click **Copy** next to **Webhook URL**. It points at the selected host, ending in `/api/v1/webhooks/github`.
2. In your GitHub repository, open **Settings**, **Webhooks**, **Add webhook**.
3. Set **Payload URL** to the copied URL and **Content type** to `application/json`.
4. Set **Secret** to the same value as your Orca webhook secret.
5. Choose to select individual events, and tick **Packages**.

The daemon handles `package` and `registry_package` events with the action `published` or `updated`, for container packages. It builds the image name as `ghcr.io/<owner>/<package>` and takes the tag from the event, defaulting to `latest`. Other events, such as `push`, are acknowledged and ignored.

### Example GitHub Actions workflow

This workflow builds the image on every push to `main` and on version tags, and pushes it to `ghcr.io`. Each push publishes a package version, which triggers the webhook.

```yaml title=".github/workflows/publish.yml"
name: Publish image

on:
  push:
    branches: [main]
    tags: ['v*']

permissions:
  contents: read
  packages: write

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - id: meta
        uses: docker/metadata-action@v5
        with:
          images: ghcr.io/${{ github.repository }}
          tags: |
            type=ref,event=branch
            type=ref,event=tag
            type=raw,value=latest,enable={{is_default_branch}}

      - uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
```

With this workflow, a rule with **Tag filter** `v*` deploys releases, and a rule with `main` or `latest` deploys every commit to the default branch.

For a private package, add a login for `ghcr.io` under **Settings → Registries** on the server. The daemon uses the saved credentials for the image's registry when it pulls.

## Connect Docker Hub

Docker Hub doesn't sign its webhooks, and its webhook settings only take a URL. Put the webhook secret in the URL as a `token` parameter:

```text
https://orca.example.com/api/v1/webhooks/dockerhub?token=<your webhook secret>
```

Add a webhook with that URL in the repository's webhook settings on Docker Hub. The daemon compares the token with the secret in constant time. It also accepts the secret in an `X-Orca-Webhook-Token` header, for senders that can set headers.

Because the secret is part of the URL, use HTTPS, and keep in mind that proxies in front of the daemon may log it.

Private Docker Hub images need a Docker Hub login under **Settings → Registries**.

The daemon reads the tag from `push_data.tag` and the image from `repository.repo_name`, as `docker.io/<repo>`. Official images with one-segment names become `docker.io/library/<repo>`.

## What is preserved

The new container keeps its name and this configuration from the old one:

- Command, entrypoint, environment variables, user and working directory
- Labels and exposed ports
- Volume binds and port bindings
- Network mode and restart policy
- Memory and CPU limits

Other settings are not copied, including extra networks beyond the primary network mode, mounts not defined as binds, health checks, hostname, added capabilities, devices, privileged mode, extra hosts and logging configuration. Compose containers are recreated one at a time like any other container, with no stack-level handling.

> [!WARNING]
> The old container is removed before the new one is created. If creation fails, for example because a port is taken, no container is left running and nothing is rolled back. Check the deploy history after the first deploy of a new rule.

## Deploy history

The **Deploy history** section at the bottom of the **Auto-deploy** tab lists recent deploys with **Time**, **Rule**, **Image**, **Container** and **Status**. Failed deploys show the error under the status. A failed pull is recorded once per rule with the container shown as `N/A`.

The daemon keeps the last 100 records in its `config.json` and the tab shows the most recent 20. It loads when you open the page, so reopen it to see new entries.

Webhooks that match no rule, or match a rule but find no containers, don't create a history entry. Look in the daemon log for lines starting with `Webhook:` and `Auto-deploy:`:

```bash
journalctl -u orca-daemon | grep -E 'Webhook:|Auto-deploy:'
```

## Troubleshooting

A successful webhook returns `{"accepted":true,"matched_rules":N}`. That means the deploy was queued, not that it finished. Rejected webhooks return HTTP 500 with an `error` message, which GitHub shows under **Recent Deliveries** for the webhook.

| Message | Cause |
|---|---|
| `webhook rejected: invalid or missing signature` | No webhook secret is set on this host, or the secret in GitHub differs from the one in Orca. |
| `unauthorized webhook` | The Docker Hub request had no token, or the wrong one. |
| `Not a container package event` | The package is not a container image. |
| `webhook body too large` | The payload is over 1 MiB. |

At most eight auto-deploys run at the same time on one daemon.
