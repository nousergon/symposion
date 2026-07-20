let activePersonaId = null;
let providers = [];
let claudeModels = [];
let permissionModes = [];
let defaults = null;
let dirBrowserPath = null; // current directory shown in the workspace picker modal
let selectedBackend = "api";
let activeStream = null;
let streamingBubble = null;
let thinkingBubble = null;
let latestPersonas = []; // last /api/personas snapshot, kept for sync lookups (e.g. the blocked card)
let stagedAttachments = []; // [{ file: File, localId }] - staged for the NEXT send, cleared after submit

const personaListEl = document.getElementById("persona-list");
const chatHeaderTextEl = document.getElementById("chat-header-text");
const handoffBtnEl = document.getElementById("handoff-btn");
const handoffCardEl = document.getElementById("handoff-card");
const chatMessagesEl = document.getElementById("chat-messages");
const chatFormEl = document.getElementById("chat-form");
const chatTextEl = document.getElementById("chat-text");
const chatFileInputEl = document.getElementById("chat-file-input");
const chatAttachBtnEl = document.getElementById("chat-attach-btn");
const chatMicBtnEl = document.getElementById("chat-mic-btn");
const stagedAttachmentsEl = document.getElementById("staged-attachments");
const newAgentBtn = document.getElementById("new-agent-btn");
const restartServerBtn = document.getElementById("restart-server-btn");
const blockedCardEl = document.getElementById("blocked-card");
const renameBtnEl = document.getElementById("rename-btn");

const modalEl = document.getElementById("new-agent-modal");
const modalNameEl = document.getElementById("new-agent-name");
const modalRandomizeNameEl = document.getElementById("new-agent-randomize-name");
const modalModelEl = document.getElementById("new-agent-model");
const modalCancelEl = document.getElementById("new-agent-cancel");
const modalCreateEl = document.getElementById("new-agent-create");
const modalWorkspaceEl = document.getElementById("new-agent-workspace");
const modalPermissionLabelEl = document.getElementById("new-agent-permission-label");
const modalPermissionModeEl = document.getElementById("new-agent-permission-mode");
const backendBtns = [...document.querySelectorAll(".backend-btn")];

const browseBtn = document.getElementById("new-agent-browse-btn");
const dirBrowserModalEl = document.getElementById("dir-browser-modal");
const dirBrowserPathEl = document.getElementById("dir-browser-path");
const dirBrowserListEl = document.getElementById("dir-browser-list");
const dirBrowserCancelEl = document.getElementById("dir-browser-cancel");
const dirBrowserSelectEl = document.getElementById("dir-browser-select");

async function fetchPersonas() {
  const res = await fetch("/api/personas");
  return res.json();
}

async function fetchProviders() {
  const res = await fetch("/api/providers");
  return res.json();
}

async function fetchClaudeModels() {
  const res = await fetch("/api/claude-models");
  return res.json();
}

async function fetchPermissionModes() {
  const res = await fetch("/api/claude-permission-modes");
  return res.json();
}

async function fetchDefaults() {
  const res = await fetch("/api/defaults");
  return res.json();
}

async function fetchRandomName() {
  const res = await fetch("/api/random-name");
  const data = await res.json();
  return data.name;
}

async function fetchBrowseDir(dirPath) {
  const url = dirPath ? `/api/browse-dir?path=${encodeURIComponent(dirPath)}` : "/api/browse-dir";
  const res = await fetch(url);
  return res.json();
}

/**
 * The countdown itself is confirmed accurate for claude-code personas
 * (real 1-hour ephemeral cache window) but is a best-guess stand-in for
 * api-backend ones - the real per-provider cache TTL isn't observable
 * through OpenCode's abstraction (symposion#5). The "~" marks that
 * uncertainty rather than showing equal confidence for both.
 */
function ttlLabel(p) {
  const min = Math.round(p.ttlRemainingMs / 60000);
  return p.ttlApproximate ? `~${min}m` : `${min}m`;
}

function modelLabel(p) {
  if (p.backend === "claude-code") {
    const model = claudeModels.find((m) => m.modelID === p.modelID);
    return `Claude Code / ${model?.name ?? p.modelID}`;
  }
  const provider = providers.find((pr) => pr.providerID === p.providerID);
  const model = provider?.models.find((m) => m.modelID === p.modelID);
  return `${provider?.name ?? p.providerID} / ${model?.name ?? p.modelID}`;
}

function workspaceLabel(p) {
  if (p.isolated) return `${p.workspaceName} (worktree: ${p.worktreeBranch})`;
  return p.workspaceName ?? "?";
}

/**
 * costUsd is the pay-as-you-go-equivalent dollar value even for
 * subscription-billed claude-code personas (the claude CLI's own result
 * event reports it directly) - a genuinely useful cost signal regardless of
 * billing model, not just for metered API-backend personas. null/0 (never
 * used yet) renders nothing rather than a clutter "$0.00".
 */
function costLabel(costUsd) {
  if (!costUsd) return null;
  return costUsd < 0.01 ? `$${costUsd.toFixed(4)}` : `$${costUsd.toFixed(2)}`;
}

function renderPersonaList(personas) {
  personaListEl.innerHTML = "";
  for (const p of personas) {
    const li = document.createElement("li");
    li.className = "persona-item" + (p.id === activePersonaId ? " active" : "") + (p.blocked ? " blocked" : "");
    li.innerHTML = `
      <span class="ttl-dot ${p.ttlStatus}" title="${p.ttlApproximate ? "Approximate - real cache window unknown for this provider" : "Confirmed 1-hour ephemeral cache window"}"></span>
      <span class="persona-name-block">
        <span class="persona-name">${p.blocked ? '<span class="blocked-flag">⚠</span>' : ""}${p.handoff ? '<span class="handoff-flag" title="Handed off to Remote Control">📱</span>' : ""}${p.name}${p.alive ? "" : " (crashed)"}</span>
        <span class="persona-model">${modelLabel(p)} · ${workspaceLabel(p)}${costLabel(p.totalCostUsd) ? ` · ${costLabel(p.totalCostUsd)}` : ""}</span>
      </span>
      <span class="ttl-label" title="${p.ttlApproximate ? "Approximate - real cache window unknown for this provider" : "Confirmed 1-hour ephemeral cache window"}">${ttlLabel(p)}</span>
      <button type="button" class="persona-rename" title="Rename agent" data-id="${p.id}">✎</button>
      <button type="button" class="persona-delete" title="Delete agent" data-id="${p.id}">×</button>
    `;
    li.addEventListener("click", () => selectPersona(p));
    li.querySelector(".persona-rename").addEventListener("click", (e) => {
      e.stopPropagation();
      renamePersona(p);
    });
    li.querySelector(".persona-delete").addEventListener("click", (e) => {
      e.stopPropagation();
      deletePersona(p);
    });
    personaListEl.appendChild(li);
  }
}

/** Rename is possible at any time, not just at creation - prompt() mirrors the existing confirm()-based delete flow rather than adding a whole inline-edit UI for one text field. */
async function renamePersona(p) {
  const next = prompt("Rename agent:", p.name);
  if (next === null) return;
  const name = next.trim();
  if (!name || name === p.name) return;

  const res = await fetch(`/api/personas/${p.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const data = await res.json();
    alert(`Rename failed: ${data.error}`);
    return;
  }
  await refreshPersonas();
}

async function deletePersona(p) {
  if (!confirm(`Delete "${p.name}"? This fully winds down its backend (kills the process, removes its worktree/branch or OpenCode session) - not reversible.`)) return;

  await fetch(`/api/personas/${p.id}`, { method: "DELETE" });

  if (p.id === activePersonaId) {
    activePersonaId = null;
    if (activeStream) { activeStream.close(); activeStream = null; }
    chatHeaderTextEl.textContent = "Select or create an agent to begin";
    renameBtnEl.hidden = true;
    handoffBtnEl.hidden = true;
    handoffCardEl.hidden = true;
    handoffCardEl.innerHTML = "";
    chatMessagesEl.innerHTML = "";
    chatTextEl.disabled = true;
    chatAttachBtnEl.disabled = true;
    chatMicBtnEl.disabled = true;
    stopDictation();
    document.getElementById("chat-send-btn").disabled = true;
    stagedAttachments = [];
    renderStagedAttachments();
  }

  await refreshPersonas();
}

async function refreshPersonas() {
  const personas = await fetchPersonas();
  latestPersonas = personas;
  renderPersonaList(personas);
  const active = personas.find((p) => p.id === activePersonaId);
  renderBlockedCard(active);
  renderHandoffState(active);
  // Keeps the header text (which includes the name) in sync with a rename -
  // whether it happened in this tab just now, or another tab within the last
  // poll interval - without a dedicated "renamed" re-render path.
  if (active) chatHeaderTextEl.textContent = `${active.name} — ${modelLabel(active)} — ${workspaceLabel(active)}`;
  return personas;
}

/** Enables/disables the whole composer row - used while a persona is handed off to Remote Control. */
function setComposerEnabled(enabled) {
  chatTextEl.disabled = !enabled;
  chatAttachBtnEl.disabled = !enabled;
  chatMicBtnEl.disabled = !enabled;
  document.getElementById("chat-send-btn").disabled = !enabled;
  chatTextEl.placeholder = enabled ? "Message this agent..." : "Handed off to Remote Control - reclaim to message from here";
  if (!enabled) stopDictation();
}

/**
 * Keeps the header button, the handoff card, and the composer in sync with
 * the active persona's handoff state on every refresh (5s poll + SSE
 * events) - so a handoff started or reclaimed from another tab converges
 * here too. Idempotent by re-rendering only when the card's content would
 * actually change (keyed on the URL + liveness), so the QR <img> isn't
 * re-fetched every poll.
 */
function renderHandoffState(persona) {
  if (!persona) {
    handoffBtnEl.hidden = true;
    handoffCardEl.hidden = true;
    handoffCardEl.innerHTML = "";
    return;
  }

  handoffBtnEl.hidden = persona.backend !== "claude-code" || !!persona.handoff;

  if (!persona.handoff) {
    if (!handoffCardEl.hidden) {
      handoffCardEl.hidden = true;
      handoffCardEl.innerHTML = "";
      setComposerEnabled(true);
    }
    return;
  }

  setComposerEnabled(false);
  const key = `${persona.handoff.url}|${persona.handoff.alive}`;
  if (handoffCardEl.dataset.key === key && !handoffCardEl.hidden) return;
  handoffCardEl.dataset.key = key;
  handoffCardEl.hidden = false;
  handoffCardEl.innerHTML = `
    <div class="handoff-card-title">📱 Handed off to Remote Control${persona.handoff.alive ? "" : " · <span class=\"handoff-dead\">process ended</span>"}</div>
    <div class="handoff-card-body">
      <img class="handoff-qr" src="/api/personas/${persona.id}/handoff-qr" alt="QR code for the Remote Control session" />
      <div class="handoff-card-detail">
        <div>Scan with your phone's camera, open the link in the Claude app, or find this session in claude.ai/code.</div>
        <a href="${escapeHtml(persona.handoff.url)}" target="_blank" rel="noopener">${escapeHtml(persona.handoff.url)}</a>
        <div class="handoff-hint">Messaging from symposion is paused while the session is remote. Reclaiming imports everything done remotely back into this chat.</div>
      </div>
    </div>
    <div class="handoff-card-actions">
      <button type="button" id="handoff-reclaim-btn" class="blocked-btn allow">Reclaim session</button>
    </div>
  `;
  handoffCardEl.querySelector("#handoff-reclaim-btn").addEventListener("click", async () => {
    handoffCardEl.querySelectorAll("button").forEach((b) => (b.disabled = true));
    const res = await fetch(`/api/personas/${persona.id}/reclaim`, { method: "POST" });
    const data = await res.json();
    if (data.importError) alert(`Session reclaimed, but importing the remote turns failed:\n${data.importError}\n\nThe conversation itself is intact in Claude's own session history.`);
    handoffCardEl.hidden = true;
    handoffCardEl.innerHTML = "";
    delete handoffCardEl.dataset.key;
    setComposerEnabled(true);
    await refreshPersonas();
    await loadMessages();
  });
}

renameBtnEl.addEventListener("click", () => {
  const active = latestPersonas.find((p) => p.id === activePersonaId);
  if (active) renamePersona(active);
});

handoffBtnEl.addEventListener("click", async () => {
  if (!activePersonaId) return;
  handoffBtnEl.disabled = true;
  handoffBtnEl.textContent = "📱 Handing off…";
  try {
    const res = await fetch(`/api/personas/${activePersonaId}/handoff`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) {
      alert(`Handoff failed: ${data.error}`);
      return;
    }
    await refreshPersonas();
  } finally {
    handoffBtnEl.disabled = false;
    handoffBtnEl.textContent = "📱 Hand off";
  }
});

/**
 * Renders the pending permission/question request for the active persona as
 * an actionable card, or hides it if nothing is pending. Only api-backend
 * personas can have one - claude-code personas surface blocking via
 * lastDenials on the message itself (no live pause, see server/index.mjs).
 */
function renderBlockedCard(persona) {
  if (!persona || (!persona.pendingPermission && !persona.pendingQuestion)) {
    blockedCardEl.hidden = true;
    blockedCardEl.innerHTML = "";
    return;
  }

  blockedCardEl.hidden = false;

  if (persona.pendingPermission) {
    const req = persona.pendingPermission;
    blockedCardEl.innerHTML = `
      <div class="blocked-card-title">⚠ Permission requested</div>
      <div class="blocked-card-detail"><code>${escapeHtml(req.action ?? "")}</code></div>
      ${(req.resources ?? []).map((r) => `<div class="blocked-card-resource">${escapeHtml(r)}</div>`).join("")}
      <div class="blocked-card-actions">
        <button type="button" data-reply="reject" class="blocked-btn deny">Deny</button>
        <button type="button" data-reply="once" class="blocked-btn">Allow once</button>
        <button type="button" data-reply="always" class="blocked-btn allow">Allow always</button>
      </div>
    `;
    blockedCardEl.querySelectorAll("[data-reply]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        blockedCardEl.querySelectorAll("button").forEach((b) => (b.disabled = true));
        await fetch(`/api/personas/${persona.id}/permission-reply`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reply: btn.dataset.reply }),
        });
        blockedCardEl.hidden = true;
        blockedCardEl.innerHTML = "";
        await refreshPersonas();
      });
    });
    return;
  }

  const req = persona.pendingQuestion;
  const questionBlocks = req.questions.map((q, qi) => `
    <div class="blocked-card-question" data-qi="${qi}">
      <div class="blocked-card-detail">${escapeHtml(q.header)}</div>
      <div class="blocked-card-question-text">${escapeHtml(q.question)}</div>
      <div class="blocked-card-options">
        ${q.options.map((o, oi) => `
          <button type="button" class="blocked-option" data-qi="${qi}" data-oi="${oi}" title="${escapeHtml(o.description)}">${escapeHtml(o.label)}</button>
        `).join("")}
      </div>
      ${q.custom ? `<input type="text" class="blocked-card-custom" data-qi="${qi}" placeholder="Other..." />` : ""}
    </div>
  `).join("");

  blockedCardEl.innerHTML = `
    <div class="blocked-card-title">⚠ Question from agent</div>
    ${questionBlocks}
    <div class="blocked-card-actions">
      <button type="button" id="blocked-question-reject" class="blocked-btn deny">Reject</button>
      <button type="button" id="blocked-question-submit" class="blocked-btn allow">Submit</button>
    </div>
  `;

  const selections = req.questions.map(() => new Set());
  blockedCardEl.querySelectorAll(".blocked-option").forEach((btn) => {
    btn.addEventListener("click", () => {
      const qi = Number(btn.dataset.qi);
      const multiple = req.questions[qi].multiple;
      if (!multiple) {
        blockedCardEl.querySelectorAll(`.blocked-option[data-qi="${qi}"]`).forEach((b) => b.classList.remove("selected"));
        selections[qi].clear();
      }
      btn.classList.toggle("selected");
      const label = req.questions[qi].options[Number(btn.dataset.oi)].label;
      if (btn.classList.contains("selected")) selections[qi].add(label);
      else selections[qi].delete(label);
    });
  });

  blockedCardEl.querySelector("#blocked-question-reject").addEventListener("click", async () => {
    blockedCardEl.querySelectorAll("button").forEach((b) => (b.disabled = true));
    await fetch(`/api/personas/${persona.id}/question-reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reject: true }),
    });
    blockedCardEl.hidden = true;
    blockedCardEl.innerHTML = "";
    await refreshPersonas();
  });

  blockedCardEl.querySelector("#blocked-question-submit").addEventListener("click", async () => {
    const answers = req.questions.map((q, qi) => {
      const customEl = blockedCardEl.querySelector(`.blocked-card-custom[data-qi="${qi}"]`);
      const custom = customEl?.value.trim();
      return custom ? [custom] : [...selections[qi]];
    });
    blockedCardEl.querySelectorAll("button").forEach((b) => (b.disabled = true));
    await fetch(`/api/personas/${persona.id}/question-reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers }),
    });
    blockedCardEl.hidden = true;
    blockedCardEl.innerHTML = "";
    await refreshPersonas();
  });
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s ?? "";
  return div.innerHTML;
}

/**
 * Extensions browsers do NOT have a registered MIME type for, so `file.type`
 * comes back as "" for every one of them (confirmed: Chrome/Safari report
 * empty string for .py/.ts/.go/.yaml/etc, unlike images/PDF which they sniff
 * correctly from file headers) - exactly the code/text files this feature
 * exists for. Forcing these to "text/plain" is what makes the server's
 * isTextMime() (claude-code-backend.mjs) correctly route them to a text
 * document block instead of an opaque, wrong-media-type base64 blob.
 */
const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".py", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".json", ".yaml", ".yml", ".toml",
  ".xml", ".html", ".htm", ".css", ".scss", ".sh", ".bash", ".zsh", ".rb", ".go", ".rs", ".java", ".c",
  ".h", ".cpp", ".hpp", ".cs", ".php", ".sql", ".csv", ".log", ".ini", ".cfg", ".conf", ".env", ".rst",
  ".swift", ".kt", ".scala", ".lua", ".r", ".pl", ".vue", ".svelte", ".gitignore", ".editorconfig",
]);

function resolveMime(file) {
  const dot = file.name.lastIndexOf(".");
  const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : "";
  const base = file.name.toLowerCase();
  if (TEXT_EXTENSIONS.has(ext) || base === "dockerfile" || base === "makefile") return "text/plain";
  return file.type || "application/octet-stream";
}

// The server accepts a 25mb JSON body total (index.mjs's express.json limit).
// Base64 inflates raw bytes by ~4/3, so the total RAW staged size must stay
// well under that once every file is encoded - 17mb raw comes to ~23mb of
// base64 + JSON overhead, safely inside the ceiling. Checked client-side so
// staging returns an immediate, specific rejection instead of a same-looking
// generic failure once the POST hits the server's 413.
const MAX_SINGLE_FILE_BYTES = 15 * 1024 * 1024;
const MAX_TOTAL_STAGED_BYTES = 17 * 1024 * 1024;

/** Adds newly picked/dropped files to the staged list and re-renders the chip row - skips (with a message) anything that would blow the upload size ceiling. */
function addFilesToStaged(fileList) {
  let totalBytes = stagedAttachments.reduce((sum, a) => sum + a.file.size, 0);
  const rejected = [];
  for (const file of fileList) {
    if (file.size > MAX_SINGLE_FILE_BYTES) {
      rejected.push(`${file.name} (${formatBytes(file.size)} exceeds the ${formatBytes(MAX_SINGLE_FILE_BYTES)} per-file limit)`);
      continue;
    }
    if (totalBytes + file.size > MAX_TOTAL_STAGED_BYTES) {
      rejected.push(`${file.name} (would exceed the ${formatBytes(MAX_TOTAL_STAGED_BYTES)} combined limit for one message)`);
      continue;
    }
    totalBytes += file.size;
    stagedAttachments.push({ file, localId: `${Date.now()}-${Math.random().toString(36).slice(2)}` });
  }
  if (rejected.length) alert(`Not attached:\n${rejected.join("\n")}`);
  renderStagedAttachments();
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Chip row above the text input showing files staged for the NEXT send, each removable before it goes out. */
function renderStagedAttachments() {
  stagedAttachmentsEl.innerHTML = "";
  stagedAttachmentsEl.hidden = stagedAttachments.length === 0;
  for (const { file, localId } of stagedAttachments) {
    const chip = document.createElement("span");
    chip.className = "attachment-chip";
    chip.innerHTML = `<span class="attachment-chip-name">${escapeHtml(file.name)}</span><span class="attachment-chip-size">${formatBytes(file.size)}</span><button type="button" class="attachment-chip-remove" title="Remove">×</button>`;
    chip.querySelector(".attachment-chip-remove").addEventListener("click", () => {
      stagedAttachments = stagedAttachments.filter((a) => a.localId !== localId);
      renderStagedAttachments();
    });
    stagedAttachmentsEl.appendChild(chip);
  }
}

/** Reads a File as base64 (no `data:...;base64,` prefix - the server expects the raw payload). */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.slice(reader.result.indexOf(",") + 1));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * Appends a chip per attachment to a message bubble - an <img> thumbnail for
 * image/* mimes (fetched from the server-side GET .../attachments/:id route,
 * never inlined base64 in the polled /messages payload), otherwise a small
 * downloadable file chip. Used both for the optimistic user-message render
 * and for history replay in loadMessages().
 */
function renderAttachments(bubble, attachments, personaId) {
  if (!attachments?.length) return;
  const row = document.createElement("div");
  row.className = "msg-attachments";
  for (const a of attachments) {
    const url = `/api/personas/${personaId}/attachments/${a.id}`;
    if (a.mime?.startsWith("image/")) {
      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      const img = document.createElement("img");
      img.className = "msg-attachment-thumb";
      img.src = url;
      img.alt = a.filename ?? "";
      link.appendChild(img);
      row.appendChild(link);
    } else {
      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.className = "msg-attachment-file";
      link.textContent = `📄 ${a.filename ?? "file"}`;
      row.appendChild(link);
    }
  }
  bubble.appendChild(row);
}

/**
 * Builds a collapsed-by-default <details> disclosure listing the tool calls
 * (name, input, output) from a message's ordered `parts` - null if there
 * were none, so callers can skip appending anything. Text parts are already
 * shown as the message's own text (streamed live), so this only surfaces
 * the tool entries - symposion#4's "see what a persona actually did"
 * without disturbing the default chat-only view.
 */
/** Small per-turn cost/token caption - null if there's nothing to show (free/unmetered turn). */
function buildCostCaption(costUsd, usage) {
  const cost = costLabel(costUsd);
  if (!cost && !usage) return null;
  const caption = document.createElement("div");
  caption.className = "msg-cost";
  const tokenBits = usage
    ? [`${(usage.inputTokens ?? 0).toLocaleString()} in`, `${(usage.outputTokens ?? 0).toLocaleString()} out`]
    : [];
  if (usage?.cacheReadTokens) tokenBits.push(`${usage.cacheReadTokens.toLocaleString()} cache read`);
  caption.textContent = [cost, ...tokenBits].filter(Boolean).join(" · ");
  return caption;
}

function truncateLabel(s, n) {
  if (typeof s !== "string") return String(s ?? "");
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function elapsedLabel(startedAt) {
  const secs = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, "0")}s`;
}

/**
 * One-line label for a live (in-progress) tool entry - the raw tool name
 * alone ("Agent", "Bash") gives no sense of WHAT it's doing, which is exactly
 * the gap this live view exists to close. The Agent tool (subagent dispatch)
 * has no visibility into the subagent's own tool calls (the CLI's stream-json
 * output never emits sidechain events for it - only one running->done pair
 * for the whole dispatch), so the best available signal is its `subagent_type`
 * + `description` input plus a live elapsed timer while it runs. Other tools
 * fall back to whichever common input field reads as a summary.
 */
function toolLiveLabel(t) {
  const input = t.input ?? {};
  if (t.name === "Agent") {
    const kind = input.subagent_type ? ` (${input.subagent_type})` : "";
    const desc = input.description ?? input.prompt;
    const base = `Subagent${kind}`;
    const label = desc ? `${base} — ${truncateLabel(desc, 60)}` : base;
    return t.status === "running" && t.startedAt ? `${label} · ${elapsedLabel(t.startedAt)}` : label;
  }
  const hint = input.description ?? input.command ?? input.file_path ?? input.pattern ?? input.path ?? input.prompt;
  const name = t.name ?? "tool";
  return hint ? `${name} — ${truncateLabel(hint, 70)}` : name;
}

/**
 * Ensures the message bubble has a dedicated text-content element instead of
 * writing straight into the bubble's own textContent - once live tool
 * entries (buildLiveTools below) can be siblings inside the same bubble,
 * `bubble.textContent += chunk` would silently blow away those sibling
 * elements (textContent assignment replaces ALL children, not just text).
 */
function ensureMsgTextEl(bubble) {
  let el = bubble.querySelector(":scope > .msg-text");
  if (!el) {
    el = document.createElement("span");
    el.className = "msg-text";
    bubble.insertBefore(el, bubble.firstChild);
  }
  return el;
}

/**
 * Live-updating list of in-progress/just-finished tool calls for a turn
 * that's still streaming - the "how do I know the agent is actually working"
 * gap: previously the only mid-turn signal was a generic bouncing-dots
 * indicator for the entire duration of a turn, with zero visibility into
 * what it was doing even when it fired off a dozen-plus tool calls (e.g. a
 * Task-tool subagent fan-out) that could run for minutes. Keyed by
 * toolUseId so repeated updates (running -> done/error) update the same row
 * in place rather than appending duplicates. Superseded by the final
 * collapsed buildToolPartsToggle() once the turn's "done" event lands.
 */
function renderLiveTools(bubble) {
  let el = bubble.querySelector(":scope > .live-tools");
  if (!el) {
    el = document.createElement("div");
    el.className = "live-tools";
    bubble.appendChild(el);
  }
  el.innerHTML = "";
  for (const t of bubble._liveToolParts ?? []) {
    const row = document.createElement("div");
    row.className = `live-tool-entry ${t.status ?? "running"}${t.name === "Agent" ? " agent" : ""}`;
    const dot = document.createElement("span");
    dot.className = "live-tool-dot";
    row.appendChild(dot);
    const label = document.createElement("span");
    label.className = "live-tool-label";
    label.textContent = toolLiveLabel(t);
    row.appendChild(label);
    el.appendChild(row);
  }
}

/**
 * Re-renders every ~1s while any Agent (subagent) row is running, so the
 * elapsed timer in its label keeps ticking - a subagent dispatch can run for
 * minutes with zero other signal in between (see toolLiveLabel), so the
 * timer is the only feedback the run hasn't stalled. Self-stops once no
 * running Agent rows remain, and clearLiveTools always tears it down.
 */
function ensureLiveToolsTicker(bubble) {
  const hasRunningAgent = (bubble._liveToolParts ?? []).some((p) => p.name === "Agent" && p.status === "running");
  if (!hasRunningAgent) {
    clearInterval(bubble._liveToolsTimer);
    bubble._liveToolsTimer = null;
    return;
  }
  if (bubble._liveToolsTimer) return;
  bubble._liveToolsTimer = setInterval(() => {
    if (!bubble.isConnected) {
      clearInterval(bubble._liveToolsTimer);
      bubble._liveToolsTimer = null;
      return;
    }
    renderLiveTools(bubble);
    ensureLiveToolsTicker(bubble);
  }, 1000);
}

function upsertLiveToolPart(bubble, part) {
  bubble._liveToolParts = bubble._liveToolParts ?? [];
  const idx = bubble._liveToolParts.findIndex((p) => p.toolUseId === part.toolUseId);
  const startedAt = idx >= 0 ? bubble._liveToolParts[idx].startedAt : Date.now();
  const merged = { ...part, startedAt };
  if (idx >= 0) bubble._liveToolParts[idx] = merged;
  else bubble._liveToolParts.push(merged);

  renderLiveTools(bubble);
  ensureLiveToolsTicker(bubble);
}

function clearLiveTools(bubble) {
  bubble.querySelector(":scope > .live-tools")?.remove();
  bubble._liveToolParts = null;
  clearInterval(bubble._liveToolsTimer);
  bubble._liveToolsTimer = null;
}

function buildToolPartsToggle(parts) {
  const toolParts = (parts ?? []).filter((p) => p.type === "tool");
  if (toolParts.length === 0) return null;

  const details = document.createElement("details");
  details.className = "tool-parts";
  const summary = document.createElement("summary");
  summary.textContent = `${toolParts.length} tool call${toolParts.length === 1 ? "" : "s"}`;
  details.appendChild(summary);

  for (const t of toolParts) {
    const entry = document.createElement("div");
    entry.className = "tool-part-entry" + (t.isError ? " error" : "");

    const nameEl = document.createElement("div");
    nameEl.className = "tool-part-name";
    nameEl.textContent = t.name ?? "tool";
    entry.appendChild(nameEl);

    const inputEl = document.createElement("pre");
    inputEl.className = "tool-part-input";
    inputEl.textContent = JSON.stringify(t.input ?? {}, null, 2);
    entry.appendChild(inputEl);

    if (t.output != null) {
      const outputEl = document.createElement("pre");
      outputEl.className = "tool-part-output";
      outputEl.textContent = typeof t.output === "string" ? t.output : JSON.stringify(t.output, null, 2);
      entry.appendChild(outputEl);
    }

    details.appendChild(entry);
  }

  return details;
}

/**
 * Shows a "thinking" bubble immediately on send, before any real content
 * exists to render - without it there's dead air for however long a turn
 * spends on reasoning/tool calls before its first text delta (can be many
 * seconds), which reads as "did this even register my message?".
 */
function showThinkingIndicator() {
  clearThinkingIndicator();
  thinkingBubble = document.createElement("div");
  thinkingBubble.className = "msg assistant thinking";
  thinkingBubble.innerHTML = "<span></span><span></span><span></span>";
  chatMessagesEl.appendChild(thinkingBubble);
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

function clearThinkingIndicator() {
  thinkingBubble?.remove();
  thinkingBubble = null;
}

function connectStream(personaId) {
  if (activeStream) activeStream.close();
  streamingBubble = null;
  clearThinkingIndicator();
  activeStream = new EventSource(`/api/personas/${personaId}/stream`);
  activeStream.onmessage = (e) => {
    const evt = JSON.parse(e.data);
    if (evt.type === "delta") {
      clearThinkingIndicator();
      if (!streamingBubble) {
        streamingBubble = document.createElement("div");
        streamingBubble.className = "msg assistant";
        chatMessagesEl.appendChild(streamingBubble);
      }
      ensureMsgTextEl(streamingBubble).textContent += evt.text;
      chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
    } else if (evt.type === "tool") {
      // First real signal of activity on a turn that opens with tool calls
      // before any text (e.g. a Task-tool subagent dispatch) - clear the
      // opaque "thinking" dots and start showing what's actually running.
      clearThinkingIndicator();
      if (!streamingBubble) {
        streamingBubble = document.createElement("div");
        streamingBubble.className = "msg assistant";
        chatMessagesEl.appendChild(streamingBubble);
      }
      upsertLiveToolPart(streamingBubble, evt);
      chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
    } else if (evt.type === "done") {
      clearThinkingIndicator();
      // A turn that only used tools (no text delta ever arrived) never
      // created streamingBubble above - build one now so the reply still
      // shows up immediately instead of waiting for the next poll.
      if (!streamingBubble && (evt.text || evt.parts?.length)) {
        streamingBubble = document.createElement("div");
        streamingBubble.className = "msg assistant";
        chatMessagesEl.appendChild(streamingBubble);
      }
      if (streamingBubble) {
        if (evt.text) ensureMsgTextEl(streamingBubble).textContent = evt.text;
        // The live in-progress list is superseded by the full collapsed
        // detail toggle below - drop it rather than show the same tool
        // calls twice.
        clearLiveTools(streamingBubble);
        streamingBubble.classList.toggle("blocked", (evt.denials?.length ?? 0) > 0);
        const toggle = buildToolPartsToggle(evt.parts);
        if (toggle) streamingBubble.appendChild(toggle);
        const costCaption = buildCostCaption(evt.costUsd, evt.usage);
        if (costCaption) streamingBubble.appendChild(costCaption);
      }
      streamingBubble = null;
      refreshPersonas();
    } else if (evt.type === "blocked" || evt.type === "unblocked") {
      clearThinkingIndicator();
      refreshPersonas();
    } else if (evt.type === "renamed") {
      // A rename from another tab (or the persona-list rename button, which
      // already refreshes itself) - re-sync the header/sidebar immediately
      // instead of waiting for the 5s poll.
      refreshPersonas();
    } else if (evt.type === "handoff") {
      // Handoff started or reclaimed (possibly from another tab) - re-sync
      // the card/composer, and on reclaim reload history so the imported
      // remote turns appear.
      refreshPersonas().then(() => {
        if (evt.state === "reclaimed") loadMessages();
      });
    }
  };
}

async function selectPersona(p) {
  // Re-clicking the already-active persona is a no-op: connectStream() would
  // otherwise tear down and re-open the live SSE subscription, and
  // loadMessages() would wipe/rebuild the chat panel, for a view that hasn't
  // actually changed - pure churn with a chance of visible flicker on a turn
  // that's still streaming.
  if (p.id === activePersonaId) return;
  activePersonaId = p.id;
  chatHeaderTextEl.textContent = `${p.name} — ${modelLabel(p)} — ${workspaceLabel(p)}`;
  renameBtnEl.hidden = false;
  // Force the handoff card to re-render for the newly selected persona even
  // if its cache key happens to match the previous persona's.
  delete handoffCardEl.dataset.key;
  handoffCardEl.hidden = true;
  handoffCardEl.innerHTML = "";
  setComposerEnabled(!p.handoff);
  stagedAttachments = [];
  renderStagedAttachments();
  connectStream(p.id);
  await refreshPersonas();
  await loadMessages();
}

/**
 * Loads the full message history AND re-seeds `streamingBubble` from a
 * trailing pending:true entry (see GET .../messages) if the turn currently
 * in view is still generating - this is what makes switching personas mid-
 * turn, reloading the page, or simply re-selecting a persona later, pick up
 * the response exactly where it stands server-side instead of showing
 * nothing (or a truncated fragment) until it completes.
 */
async function loadMessages() {
  if (!activePersonaId) return;
  const res = await fetch(`/api/personas/${activePersonaId}/messages`);
  const messages = await res.json();
  chatMessagesEl.innerHTML = "";
  streamingBubble = null;
  for (const m of messages) {
    const div = document.createElement("div");
    div.className = `msg ${m.role}` + (m.blocked ? " blocked" : "") + (m.viaRemote ? " via-remote" : "");
    ensureMsgTextEl(div).textContent = m.text;
    renderAttachments(div, m.attachments, activePersonaId);
    if (!m.pending) {
      const toggle = buildToolPartsToggle(m.parts);
      if (toggle) div.appendChild(toggle);
      const costCaption = buildCostCaption(m.costUsd, m.usage);
      if (costCaption) div.appendChild(costCaption);
      if (m.viaRemote) {
        const caption = document.createElement("div");
        caption.className = "msg-cost";
        caption.textContent = "via Remote Control";
        div.appendChild(caption);
      }
    } else {
      // Turn still in flight server-side - replay its tool calls so far into
      // the same live (running/done/error) view a fresh SSE "tool" event
      // would build, instead of showing a blank bubble until the next one arrives.
      for (const part of m.parts ?? []) upsertLiveToolPart(div, part);
    }
    chatMessagesEl.appendChild(div);
    if (m.pending) streamingBubble = div;
  }
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

function populateModelSelect() {
  modalModelEl.innerHTML = "";
  if (selectedBackend === "claude-code") {
    for (const m of claudeModels) {
      const opt = document.createElement("option");
      opt.value = m.modelID;
      opt.textContent = m.name;
      modalModelEl.appendChild(opt);
    }
    modalModelEl.value = defaults.claudeCodeDefault.modelID;
  } else {
    for (const p of providers) {
      const group = document.createElement("optgroup");
      group.label = p.name;
      for (const m of p.models) {
        const opt = document.createElement("option");
        opt.value = m.modelID;
        opt.textContent = m.name;
        opt.dataset.providerId = p.providerID;
        group.appendChild(opt);
      }
      modalModelEl.appendChild(group);
    }
    modalModelEl.value = defaults.apiDefault.modelID;
  }
}

/** Permission policy only applies to claude-code personas - api-backend blocking is handled per-request via #2's card, not a spawn-time flag. */
function populatePermissionModeSelect() {
  const show = selectedBackend === "claude-code";
  modalPermissionLabelEl.hidden = !show;
  modalPermissionModeEl.hidden = !show;
  if (!show) return;
  modalPermissionModeEl.innerHTML = "";
  for (const m of permissionModes) {
    const opt = document.createElement("option");
    opt.value = m.value;
    opt.textContent = m.name;
    modalPermissionModeEl.appendChild(opt);
  }
}

backendBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    selectedBackend = btn.dataset.backend;
    backendBtns.forEach((b) => b.classList.toggle("active", b === btn));
    populateModelSelect();
    populatePermissionModeSelect();
  });
});

/**
 * Renders the directory-navigator modal for `dirPath` (any absolute path -
 * not scoped to ~/Development, unlike the old datalist-of-suggestions this
 * replaced). ".." navigates to the parent unless already at the filesystem
 * root; clicking a folder row navigates into it. "Select this folder"
 * writes the current path into the workspace text input and closes the
 * modal - the text input itself is left editable too, for anyone who'd
 * rather just paste/type a path directly.
 */
async function renderDirBrowser(dirPath) {
  const data = await fetchBrowseDir(dirPath);
  dirBrowserPath = data.path;
  dirBrowserPathEl.textContent = data.path;
  dirBrowserListEl.innerHTML = "";

  if (data.parent) {
    const up = document.createElement("li");
    up.className = "dir-browser-item dir-browser-up";
    up.textContent = ".. (up)";
    up.addEventListener("click", () => renderDirBrowser(data.parent));
    dirBrowserListEl.appendChild(up);
  }

  for (const entry of data.entries) {
    const li = document.createElement("li");
    li.className = "dir-browser-item";
    li.textContent = entry.name;
    li.addEventListener("click", () => renderDirBrowser(entry.path));
    dirBrowserListEl.appendChild(li);
  }
}

browseBtn.addEventListener("click", () => {
  dirBrowserModalEl.hidden = false;
  renderDirBrowser(modalWorkspaceEl.value || dirBrowserPath);
});

dirBrowserCancelEl.addEventListener("click", () => { dirBrowserModalEl.hidden = true; });

dirBrowserSelectEl.addEventListener("click", () => {
  modalWorkspaceEl.value = dirBrowserPath;
  dirBrowserModalEl.hidden = true;
});

/**
 * Restarts the whole server process (every persona, every in-flight turn -
 * not just the current one) so a deployed code update lands without
 * Activity Monitor / launchctl. The LaunchAgent's KeepAlive:true
 * (com.nousergon.symposion.plist) respawns it within a second or two of
 * exit - the server-side handler just responds then exits, same "any exit
 * is a crash to recover from" contract the documented launchctl/kill
 * restart paths already rely on. Polls /api/defaults (cheap, read-only)
 * until the fresh process answers, then does a full navigation reload so
 * updated HTML/CSS/JS ship too, not just server-side behavior.
 */
restartServerBtn.addEventListener("click", async () => {
  if (!confirm("Restart the symposion server? This drops every agent's in-flight turn, not just this one.")) return;
  restartServerBtn.disabled = true;
  restartServerBtn.classList.add("spinning");
  try {
    await fetch("/api/server/restart", { method: "POST" });
  } catch {
    // Expected - the connection can drop as the process exits mid-response.
  }
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch("/api/defaults");
      if (res.ok) {
        location.reload();
        return;
      }
    } catch {
      // Still down - keep polling.
    }
  }
  alert("Server didn't come back within 30s - check Activity Monitor or ~/Library/Logs/symposion.err.log.");
  restartServerBtn.disabled = false;
  restartServerBtn.classList.remove("spinning");
});

newAgentBtn.addEventListener("click", async () => {
  if (providers.length === 0) providers = await fetchProviders();
  if (claudeModels.length === 0) claudeModels = await fetchClaudeModels();
  if (permissionModes.length === 0) permissionModes = await fetchPermissionModes();
  if (!defaults) defaults = await fetchDefaults();
  selectedBackend = "api";
  backendBtns.forEach((b) => b.classList.toggle("active", b.dataset.backend === "api"));
  populateModelSelect();
  populatePermissionModeSelect();
  modalWorkspaceEl.value = defaults?.defaultWorkspace ?? "";
  // No name is ever required - prefill with a random star name (editable,
  // and re-rollable via the dice button) rather than leaving it blank.
  modalNameEl.value = await fetchRandomName();
  modalEl.hidden = false;
  modalNameEl.focus();
  modalNameEl.select();
});

modalRandomizeNameEl.addEventListener("click", async () => {
  modalNameEl.value = await fetchRandomName();
  modalNameEl.focus();
  modalNameEl.select();
});

modalCancelEl.addEventListener("click", () => { modalEl.hidden = true; });

modalCreateEl.addEventListener("click", async () => {
  // A blank name (user cleared the prefilled one) is fine - the server
  // generates a random star name of its own when name is omitted.
  const name = modalNameEl.value.trim();
  const modelID = modalModelEl.value;
  const workspaceDir = modalWorkspaceEl.value;

  const body = { name, backend: selectedBackend, modelID, workspaceDir };
  if (selectedBackend === "api") body.providerID = modalModelEl.selectedOptions[0]?.dataset.providerId;
  else if (modalPermissionModeEl.value) body.permissionMode = modalPermissionModeEl.value;

  const res = await fetch("/api/personas", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const persona = await res.json();
  modalEl.hidden = true;
  await selectPersona(persona);
});

chatAttachBtnEl.addEventListener("click", () => chatFileInputEl.click());

chatFileInputEl.addEventListener("change", () => {
  addFilesToStaged(chatFileInputEl.files);
  chatFileInputEl.value = ""; // reset so picking the same file again still fires "change"
});

// Drag-and-drop straight onto the message pane as a second way to stage
// files, alongside the 📎 button - dragover must be prevented too, or the
// browser's default (usually "open the file instead of dropping") wins.
chatMessagesEl.addEventListener("dragover", (e) => {
  if (!activePersonaId) return;
  e.preventDefault();
  chatMessagesEl.classList.add("drag-over");
});
chatMessagesEl.addEventListener("dragleave", () => chatMessagesEl.classList.remove("drag-over"));
chatMessagesEl.addEventListener("drop", (e) => {
  if (!activePersonaId) return;
  e.preventDefault();
  chatMessagesEl.classList.remove("drag-over");
  if (e.dataTransfer.files.length) addFilesToStaged(e.dataTransfer.files);
});

/**
 * Speech-to-text dictation for the composer, via the browser's native
 * SpeechRecognition (Web Speech API) - client-side only, no server round
 * trip. Chrome/Edge support it; Safari/Firefox don't expose the
 * constructor, so the mic button stays hidden there rather than showing a
 * control that would just fail silently on click.
 */
const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognizer = null;
let dictationBaseText = "";

function stopDictation() {
  if (recognizer) recognizer.stop();
}

function startDictation() {
  dictationBaseText = chatTextEl.value.trim();
  recognizer = new SpeechRecognitionCtor();
  recognizer.lang = navigator.language || "en-US";
  recognizer.continuous = true;
  recognizer.interimResults = true;

  recognizer.onstart = () => chatMicBtnEl.classList.add("recording");

  recognizer.onresult = (event) => {
    let finalText = "";
    let interimText = "";
    for (let i = 0; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) finalText += result[0].transcript;
      else interimText += result[0].transcript;
    }
    const prefix = dictationBaseText ? `${dictationBaseText} ` : "";
    chatTextEl.value = `${prefix}${finalText}${interimText}`;
  };

  recognizer.onerror = () => stopDictation();

  recognizer.onend = () => {
    chatMicBtnEl.classList.remove("recording");
    dictationBaseText = chatTextEl.value.trim();
    recognizer = null;
    chatTextEl.focus();
  };

  recognizer.start();
}

if (SpeechRecognitionCtor) {
  chatMicBtnEl.hidden = false;
  chatMicBtnEl.addEventListener("click", () => {
    if (recognizer) stopDictation();
    else startDictation();
  });
}

chatFormEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  stopDictation();
  const text = chatTextEl.value.trim();
  if ((!text && stagedAttachments.length === 0) || !activePersonaId) return;
  chatTextEl.value = "";

  const attachments = await Promise.all(
    stagedAttachments.map(async ({ file }) => ({ filename: file.name, mime: resolveMime(file), base64: await fileToBase64(file) }))
  );
  // Metadata-only shape for the optimistic local render - the real ids come
  // back once the server persists them, but the local bubble doesn't need to
  // wait for that round trip since it renders straight from the File objects
  // via a throwaway object URL rather than the /attachments/:id route.
  const stagedForRender = stagedAttachments.map(({ file }) => ({ filename: file.name, mime: resolveMime(file), _localUrl: URL.createObjectURL(file) }));
  stagedAttachments = [];
  renderStagedAttachments();

  // optimistic render of the user's own message
  const userDiv = document.createElement("div");
  userDiv.className = "msg user";
  userDiv.textContent = text;
  for (const a of stagedForRender) {
    const row = userDiv.querySelector(":scope > .msg-attachments") ?? userDiv.appendChild(Object.assign(document.createElement("div"), { className: "msg-attachments" }));
    if (a.mime?.startsWith("image/")) {
      const img = document.createElement("img");
      img.className = "msg-attachment-thumb";
      // Revoke once decoded - the object URL only needs to live long enough
      // for the browser to load/decode the bitmap once; holding it open for
      // the rest of the session leaks the underlying Blob for every
      // image ever attached.
      img.addEventListener("load", () => URL.revokeObjectURL(a._localUrl), { once: true });
      img.src = a._localUrl;
      img.alt = a.filename;
      row.appendChild(img);
    } else {
      const chip = document.createElement("span");
      chip.className = "msg-attachment-file";
      chip.textContent = `📄 ${a.filename}`;
      row.appendChild(chip);
    }
  }
  chatMessagesEl.appendChild(userDiv);
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  showThinkingIndicator();

  // The assistant reply is rendered live via the SSE stream (connectStream) -
  // this POST just kicks the turn off and waits for it to fully resolve.
  await fetch(`/api/personas/${activePersonaId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, attachments }),
  });
});

(async () => {
  providers = await fetchProviders();
  claudeModels = await fetchClaudeModels();
  await refreshPersonas();
})();
setInterval(refreshPersonas, 5000); // keep TTL dots live
