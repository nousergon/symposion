#!/bin/bash
# Polls origin/main for new commits and, if the local checkout is clean and
# on main, fast-forwards and restarts the server - closes the loop between
# "PR merged on GitHub" and "the running local server actually serves that
# code" without a human remembering to git-pull + kick the LaunchAgent.
#
# Deliberately conservative: only acts when HEAD is main AND the working
# tree is clean, since ~/Development/symposion is also the live dev
# checkout, not a deploy-only clone. Uncommitted work or a feature branch
# checked out for active development is left alone - the next interval
# retries once that state clears.
set -euo pipefail

REPO_DIR="$HOME/Development/symposion"
LOCK_DIR="/tmp/symposion-auto-update.lock.d"
LABEL="com.nousergon.symposion"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  exit 0
fi
trap 'rmdir "$LOCK_DIR"' EXIT

cd "$REPO_DIR"

branch="$(git branch --show-current)"
if [ "$branch" != "main" ]; then
  echo "$(date -u +%FT%TZ) skip: on branch '$branch', not main"
  exit 0
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "$(date -u +%FT%TZ) skip: working tree dirty"
  exit 0
fi

git fetch origin main --quiet

local_sha="$(git rev-parse main)"
remote_sha="$(git rev-parse origin/main)"

if [ "$local_sha" = "$remote_sha" ]; then
  exit 0
fi

echo "$(date -u +%FT%TZ) update: $local_sha to $remote_sha"
git merge --ff-only origin/main

if git diff --name-only "$local_sha" "$remote_sha" | grep -q '^package-lock.json$'; then
  echo "$(date -u +%FT%TZ) package-lock.json changed, running npm ci"
  npm ci --quiet
fi

echo "$(date -u +%FT%TZ) restarting the server process"
launchctl kickstart -k "gui/$(id -u)/$LABEL"
