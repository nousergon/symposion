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
