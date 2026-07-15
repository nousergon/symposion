let activePersonaId = null;
let providers = [];
let claudeModels = [];
let permissionModes = [];
let workspaces = [];
let defaults = null;
let selectedBackend = "api";
let activeStream = null;
let streamingBubble = null;
let latestPersonas = []; // last /api/personas snapshot, kept for sync lookups (e.g. the blocked card)

const personaListEl = document.getElementById("persona-list");
const chatHeaderEl = document.getElementById("chat-header");
const chatMessagesEl = document.getElementById("chat-messages");
const chatFormEl = document.getElementById("chat-form");
const chatTextEl = document.getElementById("chat-text");
const newAgentBtn = document.getElementById("new-agent-btn");
const blockedCardEl = document.getElementById("blocked-card");

const modalEl = document.getElementById("new-agent-modal");
const modalNameEl = document.getElementById("new-agent-name");
const modalModelEl = document.getElementById("new-agent-model");
const modalCancelEl = document.getElementById("new-agent-cancel");
const modalCreateEl = document.getElementById("new-agent-create");
const modalWorkspaceEl = document.getElementById("new-agent-workspace");
const modalPermissionLabelEl = document.getElementById("new-agent-permission-label");
const modalPermissionModeEl = document.getElementById("new-agent-permission-mode");
const backendBtns = [...document.querySelectorAll(".backend-btn")];

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

async function fetchWorkspaces() {
  const res = await fetch("/api/workspaces");
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

function renderPersonaList(personas) {
  personaListEl.innerHTML = "";
  for (const p of personas) {
    const li = document.createElement("li");
    li.className = "persona-item" + (p.id === activePersonaId ? " active" : "") + (p.blocked ? " blocked" : "");
    li.innerHTML = `
      <span class="ttl-dot ${p.ttlStatus}" title="${p.ttlApproximate ? "Approximate - real cache window unknown for this provider" : "Confirmed 1-hour ephemeral cache window"}"></span>
      <span class="persona-name-block">
        <span class="persona-name">${p.blocked ? '<span class="blocked-flag">⚠</span>' : ""}${p.name}${p.alive ? "" : " (crashed)"}</span>
        <span class="persona-model">${modelLabel(p)} · ${workspaceLabel(p)}</span>
      </span>
      <span class="ttl-label" title="${p.ttlApproximate ? "Approximate - real cache window unknown for this provider" : "Confirmed 1-hour ephemeral cache window"}">${ttlLabel(p)}</span>
      <button type="button" class="persona-delete" title="Delete agent" data-id="${p.id}">×</button>
    `;
    li.addEventListener("click", () => selectPersona(p));
    li.querySelector(".persona-delete").addEventListener("click", (e) => {
      e.stopPropagation();
      deletePersona(p);
    });
    personaListEl.appendChild(li);
  }
}

async function deletePersona(p) {
  if (!confirm(`Delete "${p.name}"? This fully winds down its backend (kills the process, removes its worktree/branch or OpenCode session) - not reversible.`)) return;

  await fetch(`/api/personas/${p.id}`, { method: "DELETE" });

  if (p.id === activePersonaId) {
    activePersonaId = null;
    if (activeStream) { activeStream.close(); activeStream = null; }
    chatHeaderEl.textContent = "Select or create an agent to begin";
    chatMessagesEl.innerHTML = "";
    chatTextEl.disabled = true;
    chatFormEl.querySelector("button").disabled = true;
  }

  await refreshPersonas();
}

async function refreshPersonas() {
  const personas = await fetchPersonas();
  latestPersonas = personas;
  renderPersonaList(personas);
  renderBlockedCard(personas.find((p) => p.id === activePersonaId));
  return personas;
}

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
 * Builds a collapsed-by-default <details> disclosure listing the tool calls
 * (name, input, output) from a message's ordered `parts` - null if there
 * were none, so callers can skip appending anything. Text parts are already
 * shown as the message's own text (streamed live), so this only surfaces
 * the tool entries - symposion#4's "see what a persona actually did"
 * without disturbing the default chat-only view.
 */
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

function connectStream(personaId) {
  if (activeStream) activeStream.close();
  streamingBubble = null;
  activeStream = new EventSource(`/api/personas/${personaId}/stream`);
  activeStream.onmessage = (e) => {
    const evt = JSON.parse(e.data);
    if (evt.type === "delta") {
      if (!streamingBubble) {
        streamingBubble = document.createElement("div");
        streamingBubble.className = "msg assistant";
        chatMessagesEl.appendChild(streamingBubble);
      }
      streamingBubble.textContent += evt.text;
      chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
    } else if (evt.type === "done") {
      if (streamingBubble) {
        streamingBubble.classList.toggle("blocked", (evt.denials?.length ?? 0) > 0);
        const toggle = buildToolPartsToggle(evt.parts);
        if (toggle) streamingBubble.appendChild(toggle);
      }
      streamingBubble = null;
      refreshPersonas();
    } else if (evt.type === "blocked" || evt.type === "unblocked") {
      refreshPersonas();
    }
  };
}

async function selectPersona(p) {
  activePersonaId = p.id;
  chatHeaderEl.textContent = `${p.name} — ${modelLabel(p)} — ${workspaceLabel(p)}`;
  chatTextEl.disabled = false;
  chatFormEl.querySelector("button").disabled = false;
  connectStream(p.id);
  await refreshPersonas();
  await loadMessages();
}

async function loadMessages() {
  if (!activePersonaId) return;
  const res = await fetch(`/api/personas/${activePersonaId}/messages`);
  const messages = await res.json();
  chatMessagesEl.innerHTML = "";
  for (const m of messages) {
    const div = document.createElement("div");
    div.className = `msg ${m.role}` + (m.blocked ? " blocked" : "");
    div.textContent = m.text;
    const toggle = buildToolPartsToggle(m.parts);
    if (toggle) div.appendChild(toggle);
    chatMessagesEl.appendChild(div);
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

function populateWorkspaceSelect() {
  const datalist = document.getElementById("workspace-datalist");
  datalist.innerHTML = "";
  // Suggestions only, not a restriction - the input accepts any absolute path.
  for (const w of workspaces) {
    const opt = document.createElement("option");
    opt.value = w.path;
    opt.label = w.name;
    datalist.appendChild(opt);
  }
  if (defaults?.defaultWorkspace) modalWorkspaceEl.value = defaults.defaultWorkspace;
}

newAgentBtn.addEventListener("click", async () => {
  if (providers.length === 0) providers = await fetchProviders();
  if (claudeModels.length === 0) claudeModels = await fetchClaudeModels();
  if (permissionModes.length === 0) permissionModes = await fetchPermissionModes();
  if (workspaces.length === 0) workspaces = await fetchWorkspaces();
  if (!defaults) defaults = await fetchDefaults();
  selectedBackend = "api";
  backendBtns.forEach((b) => b.classList.toggle("active", b.dataset.backend === "api"));
  populateModelSelect();
  populatePermissionModeSelect();
  populateWorkspaceSelect();
  modalNameEl.value = "";
  modalEl.hidden = false;
  modalNameEl.focus();
});

modalCancelEl.addEventListener("click", () => { modalEl.hidden = true; });

modalCreateEl.addEventListener("click", async () => {
  const name = modalNameEl.value.trim();
  if (!name) return;
  const modelID = modalModelEl.value;
  const workspaceDir = modalWorkspaceEl.value;

  const body = { name, backend: selectedBackend, modelID, workspaceDir };
  if (selectedBackend === "api") body.providerID = "opencode";
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

chatFormEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = chatTextEl.value.trim();
  if (!text || !activePersonaId) return;
  chatTextEl.value = "";

  // optimistic render of the user's own message
  const userDiv = document.createElement("div");
  userDiv.className = "msg user";
  userDiv.textContent = text;
  chatMessagesEl.appendChild(userDiv);
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;

  // The assistant reply is rendered live via the SSE stream (connectStream) -
  // this POST just kicks the turn off and waits for it to fully resolve.
  await fetch(`/api/personas/${activePersonaId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
});

(async () => {
  providers = await fetchProviders();
  claudeModels = await fetchClaudeModels();
  await refreshPersonas();
})();
setInterval(refreshPersonas, 5000); // keep TTL dots live
