# Process supervision (macOS launchd)

`com.nousergon.symposion.plist` is a user-level LaunchAgent: starts `server/index.mjs` on login and restarts it unconditionally on any exit (crash, `kill`, `pkill` - anything). Closes symposion#7.

## Install

Symlink (not copy) so editing the repo file takes effect on the next load, no manual re-copy step:

```
ln -sf ~/Development/symposion/infra/com.nousergon.symposion.plist ~/Library/LaunchAgents/com.nousergon.symposion.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.nousergon.symposion.plist
```

Verify it's running:

```
launchctl print gui/$(id -u)/com.nousergon.symposion | head -20
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:5173
```

## Important behavior change once installed

**`pkill -f "node server/index.mjs"` (or any plain `kill`) no longer stops the server** - launchd relaunches it within seconds, by design (`KeepAlive:true`). This is what makes it survive crashes, but it also means the ad hoc `nohup ... & disown` / `pkill` workflow used during development up to this point (issue #2 and #9) will no longer behave as expected once this is installed.

To actually stop it (e.g. to free port 5173 for a manual dev instance, or during active development on the server code):

```
launchctl bootout gui/$(id -u)/com.nousergon.symposion
```

Restart it (or pick up code changes after a `git pull`):

```
launchctl kickstart -k gui/$(id -u)/com.nousergon.symposion
```

## Uninstall

```
launchctl bootout gui/$(id -u)/com.nousergon.symposion
rm ~/Library/LaunchAgents/com.nousergon.symposion.plist
```

## Logs

```
tail -f ~/Library/Logs/symposion.log ~/Library/Logs/symposion.err.log
```

# Auto-update on merge (macOS launchd)

`com.nousergon.symposion-autoupdate.plist` + `auto-update.sh` close the loop between "a PR merges on GitHub" and "the running local server actually serves that code." Without this, a merged PR sits unpicked-up until someone remembers to `git pull` + `launchctl kickstart` (the manual step that caused the New Agent button to hang unresponsive on 2026-07-20 - the running process predated the merge that added the `/api/random-name` route it now depends on).

Runs every 5 minutes via `StartInterval` (not a filesystem watcher - a commit landing on `origin/main` is the real deploy signal here, not a local file edit, and a watcher would restart mid-edit during active development on this same checkout). Each run:

1. Skips if not on `main`, or if the working tree is dirty (this checkout doubles as the dev checkout - never clobbers in-progress work).
2. `git fetch origin main`; skips if already up to date.
3. Fast-forwards (`git merge --ff-only`) - never rewrites history, never touches a diverged branch.
4. Runs `npm ci` if `package-lock.json` changed in the pulled range.
5. `launchctl kickstart -k` the main server LaunchAgent to pick up the new code.

## Install

```
ln -sf ~/Development/symposion/infra/com.nousergon.symposion-autoupdate.plist ~/Library/LaunchAgents/com.nousergon.symposion-autoupdate.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.nousergon.symposion-autoupdate.plist
```

Requires the main `com.nousergon.symposion` LaunchAgent above already installed (this one only kickstarts it, doesn't start it standalone).

## Uninstall

```
launchctl bootout gui/$(id -u)/com.nousergon.symposion-autoupdate
rm ~/Library/LaunchAgents/com.nousergon.symposion-autoupdate.plist
```

## Logs

```
tail -f ~/Library/Logs/symposion-autoupdate.log ~/Library/Logs/symposion-autoupdate.err.log
```

# Desktop launcher (macOS app)

`Symposion.applescript` compiles into a real double-clickable/Dock-able `.app` that just opens `http://localhost:5173` in your default browser - no networking changes, stays entirely local. Deliberately NOT a tunnel/public-hosting setup - symposion depends on your local `claude`/`opencode` auth and your actual local repos, so it stays laptop-only; this just makes opening it a one-click action instead of remembering a URL.

## Install

Compiled straight into `/Applications` (not `~/Applications`) so it shows up in Launchpad/Spotlight like any other installed app, not just this user's account:

```
osacompile -o /Applications/Symposion.app infra/Symposion.applescript
```

Then drag `/Applications/Symposion.app` onto the Dock for one-click access (or launch it from Launchpad/Spotlight like any other app). Requires the LaunchAgent above (or a manually-started server) already running - the launcher just opens the browser, it doesn't start the server itself.

To give it a custom icon: select the app in Finder → Get Info → drag an image onto the icon in the top-left of the Info panel.
