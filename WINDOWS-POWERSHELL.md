# Windows: the last checks, from PowerShell

For a Claude Code session running in **PowerShell** (native Windows, not
inside WSL), on the machine where the WSL session tested this branch. It
finishes what that session couldn't do from inside WSL. Read
`WINDOWS-REPORT.md` first: it describes the machine's state and what was
found so far.

## Before you start

- `git pull --rebase` on branch `engine-clean-cut`. Build the daemon:
  `cargo build --bin orca-daemon`.
- The branch's debug daemon may still be running, and the installed Orca 0.65
  is stopped (see "State of the test machine" in the report). Check with
  `curl.exe -s http://127.0.0.1:9477/api/v1/health`: the version must be the
  branch's. Never kill `orca-daemon.exe` by name: stop a daemon you started
  by its PID.
- Don't change Docker Desktop's settings or uninstall anything. Don't touch
  the user's own distros beyond what a step says.

## 1. WSL restarts (checklist section 2)

```powershell
wsl --shutdown
Start-Sleep 40
wsl -l -v                 # orca: Running (the daemon brought it back)
docker ps                 # the gateway and projects (context orca)
curl.exe -s -X POST -H "Authorization: Bearer <token>" http://127.0.0.1:9477/api/v1/settings/reconnect
                          # "connected": true
wsl -d Ubuntu-24.04 -- cmd.exe /c ver    # prints the Windows version: interop survived
```

The token is in `%APPDATA%\orca\config.json` (`api_token`). If the engine
doesn't come back, read the daemon's log, find the cause, fix it, and run
the step again.

## 2. Mirrored networking: skip

Orca supports WSL's mirrored mode only in part, and says so. Not tested.

## 3. The docker command after Docker Desktop goes (fix this)

Docker Desktop writes `"credsStore": "desktop"` into
`%USERPROFILE%\.docker\config.json`. `docker-credential-desktop.exe` lives in
Docker Desktop's `resources\bin`. Once Docker Desktop is uninstalled, or just
off the PATH, `docker pull` and `docker login` in PowerShell fail on Orca's
engine.

Fix it in the PowerShell integration (`integrate_powershell` in
`crates/orca-backend-common/src/wsl.rs`), and when the move points PowerShell's
`docker` at Orca (`switch_cli` in `crates/orca-daemon/src/desktop.rs`): if
`credsStore` names a helper (`docker-credential-<name>.exe`) that isn't on the
PATH Orca's `docker.exe` sees, switch it to `wincred` (Windows' own credential
store). First copy the file to `config.json.orca-backup`, and keep every other
key. `wincred` needs `docker-credential-wincred.exe` on that PATH too. Check
whether Docker's Windows CLI zip includes it. If it doesn't, download it from
the `docker/docker-credential-helpers` release, check it against the
published checksum, and put it in `%LOCALAPPDATA%\orca-engine\cli`.

Test it: with Docker Desktop's `resources\bin` off the PATH, `docker pull
alpine` through context `orca` fails before the fix and works after.
`docker login` then stores into wincred. Logins kept in the
`desktop` store are not carried over: say so in the step's log line, so the
user knows to log in again.

## 4. Interactive docker (checklist section 4b): ask the user

These need a real terminal, which you don't have. Ask the user to run them
in a new PowerShell window and tell you what happened:

```powershell
docker run -it --rm alpine sh        # a "/ #" prompt; type: echo hi, then exit
docker run -d --name it-test alpine sleep 300
docker exec -it it-test sh           # a prompt; exit returns
docker rm -f it-test
cd C:\Users\EdvinSyse\code\psapp
docker compose logs -f               # follows; Ctrl+C returns within a second
```

## 5. Windows Terminal: ask the user

Ask them to open Windows Terminal's new-tab dropdown: there should be no
`orca` profile. If there is, look at
`%LOCALAPPDATA%\Microsoft\Windows Terminal\Fragments` and Terminal's
`settings.json` (`"hidden"` on generated WSL profiles), and fix whatever
makes it.

## 6. Cold boot: last, with the user

Ask the user to reboot and start Orca (the branch's build) as soon as they're
logged in, then start a new session here and check: `curl.exe -s
http://127.0.0.1:9477/api/v1/health` answers at once, and System Health's
Docker Runtime check passes within about a minute and a half
(`/environment/status`). Leave this to the end: the reboot ends this session,
so commit everything before it.

## 7. Housekeeping (admin PowerShell)

If this session is elevated, remove the Block rules a deleted test copy left
behind; otherwise give the user the command:

```powershell
Get-NetFirewallApplicationFilter | Where-Object Program -like '*orca-ecc-tools\fwtest*' | Get-NetFirewallRule | Remove-NetFirewallRule
```

## When done

- `cargo fmt`, `cargo clippy --workspace --exclude orca-gui -- -D warnings`,
  and the tests of the crates you touched.
- Tick the items in `WINDOWS-TESTING.md`, and add a short "PowerShell round"
  to `WINDOWS-REPORT.md`: what passed, what you fixed (commit hashes), what
  failed.
- Commit and push to `engine-clean-cut`. Don't merge or release.
