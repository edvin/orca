# Running only the services you need

Not everyone working on a project needs all of it all the time: search, a second frontend, mail catchers, admin tools. Orca uses Docker Compose's own **profiles** for this, so there is nothing Orca-specific to learn or write down. Your compose file stays the one source of truth, and `docker compose` in a terminal behaves the same way.

## Make a service optional

Give it a profile in the compose file:

```yaml
services:
  web:
    image: shop-web
    depends_on: [db]
  db:
    image: postgres:16
  search:
    image: elasticsearch:8
    profiles: [search]
  kibana:
    image: kibana:8
    profiles: [search]
    depends_on: [search]
  mailpit:
    image: axllent/mailpit
    profiles: [mail]
```

Services without a profile always run. Services with one run only when one of their profiles is on. A service can be in several profiles.

## Pick them in Orca

**Stacks.** A stack's page shows its profiles as cards above its services, with the services in each. Switch the ones you need and press **Apply**: Orca starts what the new set adds and stops and removes what it leaves out (volumes are kept). Orca remembers the set for that stack on your machine and starts the same set every time you start it, from the stack page, `orca deploy` or an AI agent. Services that are switched off are listed too, with a button to switch on their profile.

If a service you switch on depends on one in a profile that is off, Orca says so and offers to switch that profile on; compose refuses to start it otherwise.

**Worktree instances.** The Start dialog shows the same cards. Each worktree remembers its own choice, so a worktree for a search feature can run Elasticsearch while the others don't. From the command line:

```bash
orca up --profile search              # this worktree, with search
orca run --profile search -- npm test
```

`orca up` without `--profile` uses the worktree's last choice. Setup commands (`after_up` hooks) for a service that isn't running are skipped.

## Your choice stays yours

The chosen profiles are kept in Orca's settings on your machine, not in a file in the repository. Teammates each pick their own, and nobody commits a change to try something out.

## Coming from presets

Earlier versions of Orca had `dev.instance.presets`: named lists of services in orca.yaml. Profiles replace them. Orca ignores `presets` and `default_preset` in existing files, and the orca.yaml editor says so. To move over, give the services of a preset a profile in the compose file.
