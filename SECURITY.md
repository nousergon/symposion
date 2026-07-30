# Security Policy

## Reporting a vulnerability

If you find a security vulnerability in symposion, please report it privately:

- **Preferred:** open a [GitHub Security Advisory](https://github.com/nousergon/symposion/security/advisories/new). This keeps the discussion private until a fix ships.
- **Alternative:** email `security@nousergon.ai` with a description and reproduction steps.

Please **do not** open a public issue for security reports.

## Scope

symposion is a self-hosted, single-user chat UI that spawns real subprocesses (`claude`, `opencode serve`) and runs git commands (worktree isolation) against local repos on your behalf. In scope:

- **Unauthenticated network exposure:** the server has no auth of its own — it must never be reachable from anything but `127.0.0.1`. It binds explicitly to loopback (see `server/index.mjs`); a report that it's reachable from another host, or that a code path reintroduces a wildcard/non-loopback bind, is a valid finding.
- **Command/argument injection:** any path where persona name, workspace path, or message content reaches a shell command or subprocess argument unsanitized (worktree branch/directory naming in `server/worktree.mjs`, the `claude`/`opencode serve` spawn args) is in scope.
- **Credential exposure:** any path that leaks a provider API key, AWS credential, or SSM parameter value — through logs, error messages, a message reply, or a git commit.
- **Path traversal / worktree escape:** anything that lets a persona's isolated worktree read or write outside its own directory, or outside the target repo it was created against.
- **Secret-scanning bypass:** for the DeepSeek-real-account path specifically, anything that lets a request reach `api.deepseek.com` without going through the local content-scanning egress proxy first.

Out of scope:

- DoS via traffic volume (single-user, loopback-only, no public exposure by design).
- Cost-runaway from your own provider usage (set your own spend limits with each provider).
- Vulnerabilities in `claude`/`opencode` themselves, or in upstream dependencies not yet publicly disclosed — report those upstream first.

## Threat model assumptions

- **Single-user, localhost-only.** There is no multi-user model and the server is never meant to be reachable from another host.
- **Credentials live in your `claude`/`opencode` CLI auth, or (for the real-DeepSeek-account path) AWS SSM Parameter Store** — protect the underlying IAM/CLI credentials that grant access to those, and rotate if exposed.
- **A persona's model output is trusted enough to execute** — that's the entire point of an agentic tool. This is fundamentally different from most web apps' threat model: the tool exists to let a model run real commands in a real repo. Isolation (git worktrees) bounds *where* that happens per-persona, not *whether* it happens.
- **If your machine is compromised, this tool's threat model has already failed** — your `claude`/`opencode` auth and AWS credentials live there regardless of symposion.

## Hardening recommendations for self-hosters

- Keep the server on loopback only — don't put it behind a reverse proxy or tunnel without adding real authentication first.
- Scope any AWS IAM principal used for SSM secret resolution to least privilege (read-only on the specific `/symposion/*` parameter path).
- Set provider-side spend limits (Anthropic, DeepSeek, OpenRouter, etc.) as your backstop.
