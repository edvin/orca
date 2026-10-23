---
title: Workspace troubleshooting
nav: Troubleshooting
description: Fixes for workspace problems: clones that fail, the gateway not starting, certificates, routes that don't reach their container, secrets and setup commands.
---

This page lists the problems people run into with workspaces, what causes each, and how to fix it. For problems with Orca itself, such as the daemon or Docker not starting, see the general [Troubleshooting](/docs/troubleshooting/) page.

## Where to look first

- **The card or the join form.** Every step shows its result. When one fails, the error is shown under the steps, with the last lines of the command's output for `git`, `docker compose` and setup commands.
- **The CLI.** `orca workspace setup <project>` and `orca workspace update` print each step and fail with the same error, which is easier to copy.
- **The full log of a job.** Orca keeps the full output of the last 50 jobs while it runs, including warnings that aren't shown on the card, such as a `.env` that isn't ignored by git, or why a secret couldn't be fetched. Get it from the [API](/docs/api/#authentication):

  ```bash
  TOKEN=…   # see the API page for where to find it
  curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:9477/api/v1/dev/jobs?project=workspace"
  curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:9477/api/v1/dev/jobs/<job id>"
  ```

  The first lists the workspace's jobs, newest first; the second shows one with its `log`.
- **The Gateway page.** Its **Routes** tab shows every route, who added it, and which routes lost a hostname to another.
- **The daemon log**, for what happens when Orca starts, such as a workspace pull that was skipped. Its location is under [Logs](/docs/troubleshooting/#logs).

## The clone fails

Orca runs `git` without any prompts: with `GIT_TERMINAL_PROMPT=0`, and SSH in batch mode. Whatever would make `git clone` ask you something in a terminal makes it fail in Orca instead.

**`Permission denied (publickey)`.** Your SSH key isn't available to Orca, or isn't allowed on the repository.

1. Check that cloning works in a terminal: `git clone git@git.acme.dev:finance/billing.git /tmp/test-clone`.
2. If your key has a passphrase, it must be loaded into your SSH agent. On macOS, add it to the keychain once with `ssh-add --apple-use-keychain ~/.ssh/id_ed25519`, and add `UseKeychain yes` and `AddKeysToAgent yes` to the host's entry in `~/.ssh/config`.
3. Check you have access to that repository on your git server. Workspaces often list repositories from several teams.

**`Host key verification failed`.** Orca accepts a server's key the first time it sees it, but refuses one that changed since it was saved in `~/.ssh/known_hosts`. If the server's key really changed, remove the old entry with `ssh-keygen -R git.acme.dev` and try again.

**`could not read Username`** or an HTTPS authentication error. HTTPS URLs need a credential helper that answers without a prompt, such as the macOS keychain or Git Credential Manager. Clone once in a terminal so the helper stores your credentials, or use the SSH URL.

**Your own SSH command.** If you set `GIT_SSH_COMMAND` in the environment Orca starts with, Orca uses yours instead of its batch-mode one.

After fixing the cause, click **Set up** again, or **Join** again.

## "Already exists and isn't this workspace"

Joining stops with *"… already exists and isn't this workspace. Choose another folder."* when the folder it would clone into exists, isn't empty, and has no `orca-workspace.yaml`. Orca never clones over existing files.

Click **Clone it somewhere other than ~/code?** and choose a new folder, or move the existing one aside. If the folder is an older clone of the workspace that lacks the file, pull it in a terminal first: once it has `orca-workspace.yaml`, joining uses it as it is.

## The gateway doesn't start

The **Set up the gateway** step fails with *"the gateway didn't start; is another program using ports 80 or 443?"*.

The gateway needs ports 80 and 443. Find what holds them:

```bash
sudo lsof -nP -iTCP:443 -sTCP:LISTEN
sudo lsof -nP -iTCP:80 -sTCP:LISTEN
docker ps --filter publish=443
```

The usual cause is the team's old proxy stack still running. Stop it from its folder with `docker compose down` (without `-v`, which would delete its volumes). Other common ones are a local nginx or Apache, another development proxy, or a VPN client's web interface.

Then click **Update** on the **Workspace** page. See also [Gateway: port 80 or 443 is in use](/docs/troubleshooting/#gateway-port-80-or-443-is-in-use).

## Certificate problems

**The browser says the certificate expired.** The workspace's certificate needs renewing. The team lead replaces both files in the repo and pushes; then everyone clicks **Update**. Orca pulls on start, but only applies a new certificate on **Update**. Check a certificate's dates with:

```bash
openssl x509 -in certs/local.acme.dev.crt -noout -subject -dates -ext subjectAltName
```

**The certificate doesn't cover a hostname.** A wildcard covers exactly one level: `*.local.acme.dev` covers `billing.local.acme.dev`, not `api.billing.local.acme.dev`, and not a hostname under another domain. Use flat names such as `api-billing`. The landing page at `local.acme.dev` itself needs the bare domain in the certificate too.

**The browser says the issuer is unknown.** Either the certificate file lacks its intermediate certificates (put the full chain in the `.crt`, your certificate first), or the workspace has no certificate and you haven't trusted Orca's certificate authority yet. The **Workspace** page's chip says which: **Team certificate** or **Orca CA**. For Orca CA, run `orca ca install`; see [Browser says the certificate isn't trusted](/docs/troubleshooting/#browser-says-the-certificate-isnt-trusted).

**Join fails with "can't read the certificate file".** The paths under `gateway.certificate` are relative to the workspace folder. Check the file is committed: certificates are sometimes caught by a `.gitignore` rule such as `*.key`.

## A hostname doesn't resolve

The browser says the site can't be reached, or `curl` says it can't resolve the host. Check what the name resolves to:

```bash
dig +short billing.local.acme.dev
```

It should print `127.0.0.1`. If it prints nothing:

- The wildcard DNS record is missing or hasn't spread yet. Ask the team lead to check the domain's DNS.
- Your router, DNS filter or VPN blocks public names that point to private addresses ("DNS rebinding protection"). Allow the domain there, or use a different DNS server.

With a `*.localhost` domain, browsers resolve the names themselves, but `curl`, scripts and some browsers may not. See [Hostnames](/docs/gateway/#hostnames).

## A route shows "Not running" or 502

The landing page shows **Not running** on a card, or the browser gets a 502 error. The gateway can't reach the route's target.

1. **Is the project running?** A route exists from the moment you join, but its container only exists once the project is set up and started.
2. **Is the target name right?** Compare the route's `target` with the container name:

   ```bash
   docker ps --format '{{.Names}}'
   ```

3. **Is the container on the workspace network?** Its compose file must attach it to the network. List what's on it:

   ```bash
   docker network inspect local-dev --format '{{range .Containers}}{{.Name}} {{end}}'
   ```

   The gateway (`orca-gateway`) and the target container should both be there. If the target isn't, add the network to the project's compose file as an external network and start it again.

4. **Is the port the container's internal port?** Use the port the app listens on inside the container, such as `80`, not one published on your machine, such as `8080:80`'s `8080`. Test from the gateway:

   ```bash
   docker exec orca-gateway wget -qO- -T 5 http://billing-app:80/ | head -5
   ```

   *bad address* means the name isn't on a shared network; *connection refused* means nothing listens on that port.

## A hostname goes to the wrong place

- **Another route has it.** A hostname and path that a route added by hand on the **Gateway** page, or a worktree instance, already uses keeps going there, and the workspace's route is left out without a warning. A project's own `orca.yaml` can also hold it. Check the **Routes** tab on the **Gateway** page. See [Conflicts](/docs/workspaces-routes/#conflicts).
- **A more specific route wins.** An exact hostname beats a pattern, and a more specific pattern beats `*`. A path route only takes its own paths. See [Which route wins](/docs/workspaces-routes/#which-route-wins).
- **A name with a dot isn't under the domain.** `api.billing` is taken as a full hostname, not `api.billing.local.acme.dev`.

## WebSockets go to the wrong place

WebSocket routes come before every other route. If the workspace has a catch-all such as `{ hostname: "*", target: "soketi:6001", websocket: true }`, every WebSocket without a more specific WebSocket route goes there, including ones an app serves itself: Vite's hot reload, Livewire, GraphQL subscriptions or Reverb.

Add a WebSocket route for the app's hostname to the container that serves the socket, optionally with its `path`:

```yaml
- { hostname: billing-vite, target: "billing-vite:5173", websocket: true }
- { hostname: billing, path: "/graphql*", target: "billing-app:80", websocket: true }
```

The browser's developer tools show which URL a socket connects to under **Network**, filtered to WS.

## Secrets aren't filled in automatically

**There's no Fill in automatically button.** Orca didn't find the CLI. It looks for `passbolt` or `go-passbolt-cli` for Passbolt, and `op` for 1Password, in `/opt/homebrew/bin`, `/usr/local/bin`, Docker's own folders and the `PATH` Orca started with, but not in folders your shell adds in `~/.zshrc` or `~/.bashrc`. Link the program into `/usr/local/bin`, and reopen the dialog. See [The PATH Orca uses](/docs/workspaces-secrets/#the-path-orca-uses).

**The button is there, but a secret stays empty.** Click **Fill in automatically** in the dialog to see each failure with the CLI's error. Common ones:

| Error | Cause and fix |
|---|---|
| *the CLI didn't answer within 30 seconds* | The CLI waited for input: a passphrase, a sign-in or an approval in the 1Password app. Run the same command in a terminal; it must print the value without asking anything. Save the passphrase in go-passbolt-cli's configuration, or sign in to `op` first. |
| an error about the resource or permissions | The Passbolt entry isn't shared with you, or the id is wrong. Click **Open in Passbolt ↗** to check. |
| *the Passbolt CLI returned no password* | The entry has no password field Orca recognises. |
| *empty in the secret manager* | The entry exists, but its value is empty. |
| an account or sign-in error from `op` | You're signed in to another 1Password account. The workspace can name the account with `secrets.1password.account`. |

To test by hand, run what Orca runs:

```bash
passbolt get resource --id 7f3c91a2-5d0e-4c2b-9a51-2a9be1c3d4f0 -j
op read --no-newline "op://Dev/Stripe/secret"
```

## The project stops before starting

The card shows **N secrets to fill in**, and the steps after **Fill in secrets** say *"Waiting for the missing secrets"*. This is on purpose: setup doesn't start a project whose `.env` lacks secrets.

Fill them in with the dialog, or in the `.env` yourself, and click **Start**. See [Secrets](/docs/workspaces-secrets/).

If Orca never asks for a secret you know is missing, the `.env` has a value for it already, probably a placeholder from `.env.example`, such as `changeme`. Empty that line, or replace the value.

## The setup command fails

The **Run the setup command** step shows the error with the last lines of the command's output. Common causes:

- **`command not found`**, for example `just: command not found`. The setup command doesn't see your shell's `PATH`, nor tools set up in `~/.zshrc`, such as `nvm` or `asdf`. Install the tool into `/opt/homebrew/bin` or `/usr/local/bin`, or link it there.
- **It waits for input.** The command gets no input, so a question fails or hangs. Use the tool's non-interactive flag.
- **It needs a running service.** The setup command runs before the shared services it uses and before the project starts. Move work that needs them into the project's `orca.yaml` [hooks](/docs/orca-yaml/#hooks).
- **A registry login is missing**: `pull access denied` or `unauthorized`. See the next section.

Fix the cause and click **Start**: a setup command that failed hasn't been recorded as done, so it runs again. To run one that did succeed again, click **Run setup again** or run `orca workspace setup <project> --rerun-setup`.

## Registry login

The **Workspace** page shows **Log in to registry.acme.dev**, or images fail to pull with `unauthorized` or `pull access denied`. Log in once:

```bash
docker login registry.acme.dev
```

Orca checks `~/.docker/config.json` for an entry for the registry, from `docker login` or a credential helper, and the alert disappears on the next refresh. If your registry uses a port, such as `registry.acme.dev:5000`, log in with the port.

## The workspace file has a problem

The **Workspace** page shows **The workspace file has a problem** with the error. Someone pushed a change Orca can't read, or there's a mistake in your local copy. The error names the key: see [Errors](/docs/workspaces-reference/#errors) for each message.

Once the file is fixed, click **Update**. Until then, the routes Orca already has keep working.

## Update fails

**Update** fails at **Get the latest workspace** when `git pull --ff-only` can't fast-forward. Common causes:

- You committed something to the workspace's branch yourself. Push it, or reset to the remote branch: `git -C ~/code/dev-workspace reset --hard @{upstream}` (this discards your commits).
- The workspace folder has no remote branch, for example when you joined from a local folder you created yourself. Join again with the same path instead.
- You're offline, or lost access to the repository.

When Orca starts, the same pull is skipped quietly on failure and Orca keeps using the version you have.

## Starting the project fails

The **Start the project** step fails with *"compose up failed"* and the last lines of Docker Compose's output, or *"setup hook '…' failed"* when a hook in the project's own `orca.yaml` fails. These are problems in the project rather than the workspace: open the stack from the **Containers** page to see each service's logs, or start it in a terminal with `docker compose up` in its folder to see the full output.

## Related

- [Join and use a workspace](/docs/workspaces-join/): what each step does.
- [Troubleshooting](/docs/troubleshooting/): Orca, Docker and the gateway in general.
