# symposion

[![CI](https://github.com/nousergon/symposion/actions/workflows/ci.yml/badge.svg)](https://github.com/nousergon/symposion/actions/workflows/ci.yml)
[![Gitleaks scan](https://github.com/nousergon/symposion/actions/workflows/gitleaks.yml/badge.svg)](https://github.com/nousergon/symposion/actions/workflows/gitleaks.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-20+-blue.svg)](https://nodejs.org/)

*Symposion* (Greek: a gathering for shared discussion) is a personal web app that replaces a terminal full of `claude` sessions with a chat UI: a roster of named personas, each pinned to a model/backend/workspace, with live status (TTL countdown, blocked-on-permission, crashed) instead of guessing what a background session is doing.

## Two backends, one UI

- **Claude Code personas** run the real `claude` CLI as a persistent subprocess (`--input-format/--output-format stream-json`) — never the Agent SDK, deliberately, since Anthropic's Consumer Terms restrict subscription OAuth credentials to Claude Code and claude.ai, and shelling out to the actual CLI binary stays unambiguously inside that license.
- **API-backed personas** (OpenRouter, DeepSeek, xAI, or any other provider [OpenCode](https://opencode.ai) supports) run through OpenCode's own server, fronted via its SDK — this backend has a genuine live permission-pause/resume flow (`permission.asked`/`question.asked`), surfaced in the UI as an actionable card, unlike the Claude Code path (which has no mid-turn pause in headless mode — a blocked action shows up after the fact as `permission_denials` on the completed turn). Direct-API providers with a real (non-free-tier) key configured — currently DeepSeek and xAI — are routed through a local content-scanning egress proxy (`server/llm-egress-proxy.mjs`, one instance per provider) rather than talking to the provider directly; see that file for why.

Both backends run as persistent processes per persona, not spawned fresh per message, so prompt caching actually works. A persona pointed at a git repo runs in a dedicated worktree + branch, isolated from your own terminal sessions and every other persona on the same repo.

## Quick start

```bash
git clone https://github.com/nousergon/symposion.git
cd symposion
npm install
node server/index.mjs
```

Open `http://localhost:5173`. Claude Code personas need the `claude` CLI installed and authenticated (`claude auth login`) — no extra API key. API-backed personas need whichever provider credentials OpenCode itself is configured with (`opencode auth login`, or a provider block in `~/.config/opencode/opencode.jsonc`); without one, personas fall back to OpenCode Zen's free-tier proxy where available.

Runs standalone via `nohup`/`node server/index.mjs &`, or supervised on macOS via the launchd LaunchAgent in `infra/` (see `infra/README.md`).

## Status

Personal-use MVP, actively developed against real daily use, not a general-purpose product. See open issues for the current backlog.

## License

[MIT](LICENSE)
