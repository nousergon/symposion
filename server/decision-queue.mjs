import { execFileSync } from "node:child_process";

const BACKLOG_REPOS = ["alpha-engine-config", "metron-ops", "vires-ops", "telos-ops"];
const CODE_REPOS = [
  "alpha-engine-config", "metron-ops", "crucible-executor", "nousergon-data",
  "crucible-predictor", "crucible-research", "crucible-backtester",
  "crucible-dashboard", "crucible-evaluator", "nousergon-lib",
  "nousergon-docs", "metron", "vires", "vires-ops", "telos", "telos-ops",
];

// Every repo/number pair this module operates on must resolve against this
// allowlist before being used to build a GitHub API path — CodeQL flagged the
// prior curl/execSync string-built commands as command injection + SSRF since
// repo/number arrive from the /api/decision-queue/ruling request body.
const ALL_REPOS = new Set([...BACKLOG_REPOS, ...CODE_REPOS]);

function assertValidRepo(repo) {
  if (!ALL_REPOS.has(repo)) throw new Error(`Unknown repo: ${repo}`);
  return repo;
}

function assertValidIssueNumber(number) {
  const n = Number(number);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid issue/PR number: ${number}`);
  return n;
}

let cachedToken = null;
function ghToken() {
  if (!cachedToken) {
    cachedToken = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  }
  return cachedToken;
}

async function ghApi(path, method = "GET", body = null) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${ghToken()}`,
      Accept: "application/vnd.github+json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`GitHub API ${method} ${path} failed: ${res.status} ${await res.text()}`);
  if (res.status === 204) return null;
  return res.json();
}

async function ghGraphql(query, variables = {}) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ghToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GitHub GraphQL failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function listIssues(repo, labels) {
  assertValidRepo(repo);
  const labelQ = encodeURIComponent(labels.join(","));
  const url = `/repos/nousergon/${encodeURIComponent(repo)}/issues?state=open&labels=${labelQ}&per_page=100`;
  const items = await ghApi(url);
  return items.filter((i) => !i.pull_request).map((i) => enrichItem(i, repo));
}

async function listPrs(repo, labels) {
  assertValidRepo(repo);
  const labelQ = encodeURIComponent(labels.join(","));
  const url = `/repos/nousergon/${encodeURIComponent(repo)}/issues?state=open&labels=${labelQ}&per_page=100`;
  const items = await ghApi(url);
  return items.filter((i) => i.pull_request).map((i) => enrichItem(i, repo, true));
}

function enrichItem(raw, repo, isPr = false) {
  const labelNames = (raw.labels ?? []).map((l) => l.name);
  const getLabelVal = (prefix) => {
    const match = labelNames.find((n) => n.startsWith(prefix));
    return match ? match.split(":")[1] ?? match : null;
  };

  return {
    id: raw.id,
    number: raw.number,
    repo,
    title: raw.title,
    state: raw.state,
    url: raw.html_url,
    body: raw.body ?? "",
    author: raw.user?.login ?? "unknown",
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    isPr,
    labels: labelNames,
    priority: getLabelVal("P"),
    complexity: getLabelVal("complexity"),
    gate: getLabelVal("gate"),
  };
}

function extractAsk(body) {
  const match = body.match(/\*\*Ask:\*\*\s*([\s\S]*?)(?:\n\n|\n#{1,3}|$)/i);
  if (match) return match[1].trim();
  const askLine = body.split("\n").find((l) => l.match(/^##\s*Ask/i));
  if (askLine) {
    const idx = body.indexOf(askLine);
    const after = body.slice(idx + askLine.length).trim();
    const nextH = after.search(/\n#{1,3}\s/);
    return (nextH > 0 ? after.slice(0, nextH) : after.slice(0, 500)).trim();
  }
  return body.slice(0, 300).trim();
}

function extractRecommendation(body) {
  // Try **Recommendation:** bold format
  const m = body.match(/\*\*Recommendation:\*\*\s*([\s\S]*?)(?:\n\n|\n#{1,3}|$)/i);
  if (m) return m[1].trim();
  // Try ## Recommendation or ## Approach heading format
  const s = body.match(/##\s*Recommendation\b|##\s*Approach\b/i);
  if (!s) return null;
  const after = body.slice(s.index + s[0].length).trim();
  const nextH = after.search(/\n#{1,3}\s/);
  return (nextH > 0 ? after.slice(0, nextH) : after.slice(0, 400)).trim();
}

function extractSota(body) {
  // Try **SOTA:** bold format
  const m = body.match(/\*\*SOTA:\*\*\s*([\s\S]*?)(?:\n\n|\n#{1,3}|$)/i);
  if (m) return m[1].trim();
  // Try ## SOTA heading format
  const s = body.match(/##\s*SOTA\b/i);
  if (!s) return null;
  const after = body.slice(s.index + s[0].length).trim();
  const nextH = after.search(/\n#{1,3}\s/);
  return (nextH > 0 ? after.slice(0, nextH) : after.slice(0, 400)).trim();
}

function extractDelta(body) {
  // Try **Delta:** bold format
  const m = body.match(/\*\*Delta:\*\*\s*([\s\S]*?)(?:\n\n|\n#{1,3}|$)/i);
  if (m) return m[1].trim();
  // Try ## Delta heading format
  const s = body.match(/##\s*Delta\b/i);
  if (!s) return null;
  const after = body.slice(s.index + s[0].length).trim();
  const nextH = after.search(/\n#{1,3}\s/);
  return (nextH > 0 ? after.slice(0, nextH) : after.slice(0, 400)).trim();
}

function findClosesWhen(body) {
  const m = body.match(/\*\*Closes when\*\*|##\s*Closes when/i);
  if (!m) return null;
  const after = body.slice(m.index + m[0].length).trim();
  const nextH = after.search(/\n#{1,3}\s/);
  return (nextH > 0 ? after.slice(0, nextH) : after.slice(0, 300)).trim();
}

export async function postComment(repo, number, text) {
  assertValidRepo(repo);
  const n = assertValidIssueNumber(number);
  await ghApi(`/repos/nousergon/${encodeURIComponent(repo)}/issues/${n}/comments`, "POST", { body: text });
}

export async function removeLabels(repo, number, labelNames) {
  assertValidRepo(repo);
  const n = assertValidIssueNumber(number);
  for (const name of labelNames) {
    try {
      await ghApi(`/repos/nousergon/${encodeURIComponent(repo)}/issues/${n}/labels/${encodeURIComponent(name)}`, "DELETE");
    } catch {}
  }
}

export async function addLabels(repo, number, labelNames) {
  assertValidRepo(repo);
  const n = assertValidIssueNumber(number);
  await ghApi(`/repos/nousergon/${encodeURIComponent(repo)}/issues/${n}/labels`, "POST", { labels: labelNames });
}

export async function closeIssue(repo, number) {
  assertValidRepo(repo);
  const n = assertValidIssueNumber(number);
  await ghApi(`/repos/nousergon/${encodeURIComponent(repo)}/issues/${n}`, "PATCH", { state: "closed", state_reason: "not_planned" });
}

export async function markPrReadyForReview(repo, number) {
  assertValidRepo(repo);
  const n = assertValidIssueNumber(number);
  try {
    const prInfo = await ghApi(`/repos/nousergon/${encodeURIComponent(repo)}/pulls/${n}`);
    const nodeId = prInfo.node_id;
    if (!nodeId) return;
    const gql = `mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }`;
    await ghGraphql(gql, { id: nodeId });
  } catch {}
}

/**
 * Fetches all triage items: issues with triage:session/gate:operator/gate:decision/gate:device
 * across backlog repos, plus PRs with triage:session across all code repos.
 * Returns one combined list, oldest-first.
 */
export async function fetchQueue() {
  const all = [];

  const triageLabels = ["triage:session", "gate:operator", "gate:decision", "gate:device"];
  for (const repo of BACKLOG_REPOS) {
    try { all.push(...(await listIssues(repo, triageLabels))); } catch {}
  }

  for (const repo of CODE_REPOS) {
    try { all.push(...(await listIssues(repo, ["triage:session"]))); } catch {}
    try { all.push(...(await listPrs(repo, ["triage:session"]))); } catch {}
  }

  all.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  return all;
}

const RULING_OPTIONS = [
  { label: "Approve", value: "approve", description: "Accept as-is, next tier executes" },
  { label: "Changes requested", value: "changes", description: "Needs revision before proceeding" },
  { label: "Defer", value: "defer", description: "Postpone — set a Re-exam date or milestone" },
  { label: "Won't fix / Close", value: "wontfix", description: "Close as not planned" },
];

const MILESTONE_OPTION = { label: "Convert to milestone", value: "milestone", description: "Blocked on an event, not a date" };

/**
 * Builds a question block for one triage item, matching the Claude Code
 * AskUserQuestion shape so the existing blocked-card system renders it.
 */
export function itemToQuestion(item) {
  const ask = extractAsk(item.body);
  const recommendation = extractRecommendation(item.body);
  const sota = extractSota(item.body);
  const delta = extractDelta(item.body);
  const closesWhen = findClosesWhen(item.body);

  const optionText = item.isPr
    ? `PR ${item.repo}#${item.number}`
    : `Issue ${item.repo}#${item.number}`;

  const descParts = [
    ask ? `**Ask:** ${ask}` : null,
    recommendation ? `**Recommendation:** ${recommendation}` : null,
    sota ? `**SOTA approach:** ${sota}` : null,
    delta ? `**Delta:** ${delta}` : null,
    closesWhen ? `**Closes when:** ${closesWhen}` : null,
  ].filter(Boolean);

  const description = descParts.length > 0
    ? `${optionText}\n\n${descParts.join("\n\n")}`
    : `${item.title}\n\n${optionText}`;

  const options = [...RULING_OPTIONS];
  if (item.gate === "operator" || (ask && /\bmilestone\b/i.test(ask))) {
    options.push(MILESTONE_OPTION);
  }

  return [
    {
      header: "Decision needed",
      question: `**${item.title}**  \n${item.repo}#${item.number} · ${item.isPr ? "PR" : "Issue"}${item.priority ? ` · P${item.priority}` : ""}${item.complexity ? ` · ${item.complexity}` : ""}`,
      description,
      options,
      item,
    },
  ];
}
