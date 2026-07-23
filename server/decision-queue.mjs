import { execSync } from "node:child_process";

const BACKLOG_REPOS = ["alpha-engine-config", "metron-ops", "vires-ops", "telos-ops"];
const CODE_REPOS = [
  "alpha-engine-config", "metron-ops", "crucible-executor", "nousergon-data",
  "crucible-predictor", "crucible-research", "crucible-backtester",
  "crucible-dashboard", "crucible-evaluator", "nousergon-lib",
  "nousergon-docs", "metron", "vires", "vires-ops", "telos", "telos-ops",
];

function ghApi(path, method = "GET", body = null) {
  const token = execSync("gh auth token", { encoding: "utf8" }).trim();
  const args = ["-s", "-f", `Authorization=Bearer ${token}`];
  if (body) args.push("-d", JSON.stringify(body));
  const cmd = `curl ${args.join(" ")} "https://api.github.com${path}"`;
  return JSON.parse(execSync(cmd, { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 }));
}

function ghGraphql(query, variables = {}) {
  const token = execSync("gh auth token", { encoding: "utf8" }).trim();
  const body = JSON.stringify({ query, variables });
  const res = execSync(
    `curl -s -f -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" -d ${JSON.stringify(encodeURIComponent(body))} "https://api.github.com/graphql"`,
    { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 }
  );
  return JSON.parse(res);
}

function listIssues(repo, labels) {
  const labelQ = encodeURIComponent(labels.join(","));
  const url = `/repos/nousergon/${repo}/issues?state=open&labels=${labelQ}&per_page=100`;
  const items = ghApi(url);
  return items.filter((i) => !i.pull_request).map((i) => enrichItem(i, repo));
}

function listPrs(repo, labels) {
  const labelQ = encodeURIComponent(labels.join(","));
  const url = `/repos/nousergon/${repo}/issues?state=open&labels=${labelQ}&per_page=100`;
  const items = ghApi(url);
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
  const s = body.match(/##\s*SOTA\b|##\s*Recommendation|##\s*Approach/i);
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

export function postComment(repo, number, text) {
  ghApi(`/repos/nousergon/${repo}/issues/${number}/comments`, "POST", { body: text });
}

export function removeLabels(repo, number, labelNames) {
  for (const name of labelNames) {
    try {
      ghApi(`/repos/nousergon/${repo}/issues/${number}/labels/${encodeURIComponent(name)}`, "DELETE");
    } catch {}
  }
}

export function addLabels(repo, number, labelNames) {
  ghApi(`/repos/nousergon/${repo}/issues/${number}/labels`, "POST", { labels: labelNames });
}

export function closeIssue(repo, number) {
  ghApi(`/repos/nousergon/${repo}/issues/${number}`, "PATCH", { state: "closed", state_reason: "not_planned" });
}

export function markPrReadyForReview(repo, number) {
  try {
    const token = execSync("gh auth token", { encoding: "utf8" }).trim();
    // Fetch the PR's node_id (GraphQL global ID) first
    const prInfo = JSON.parse(execSync(
      `curl -s -H "Authorization: Bearer ${token}" "https://api.github.com/repos/nousergon/${repo}/pulls/${number}"`,
      { encoding: "utf8" }
    ));
    const nodeId = prInfo.node_id;
    if (!nodeId) return;
    const gql = `mutation { markPullRequestReadyForReview(input: { pullRequestId: "${nodeId}" }) { clientMutationId } }`;
    execSync(`curl -s -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" -d '${JSON.stringify({ query: gql })}' "https://api.github.com/graphql"`, { encoding: "utf8", maxBuffer: 1024 * 1024 });
  } catch {}
}

/**
 * Fetches all triage items: issues with triage:session/gate:operator/gate:decision/gate:device
 * across backlog repos, plus PRs with triage:session across all code repos.
 * Returns one combined list, oldest-first.
 */
export function fetchQueue() {
  const all = [];

  const triageLabels = ["triage:session", "gate:operator", "gate:decision", "gate:device"];
  for (const repo of BACKLOG_REPOS) {
    try { all.push(...listIssues(repo, triageLabels)); } catch {}
  }

  for (const repo of CODE_REPOS) {
    try { all.push(...listIssues(repo, ["triage:session"])); } catch {}
    try { all.push(...listPrs(repo, ["triage:session"])); } catch {}
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
  const closesWhen = findClosesWhen(item.body);

  const optionText = item.isPr
    ? `PR ${item.repo}#${item.number}`
    : `Issue ${item.repo}#${item.number}`;

  const descParts = [
    ask ? `**Ask:** ${ask}` : null,
    recommendation ? `**SOTA/Recommendation:** ${recommendation}` : null,
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
