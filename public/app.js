let activePersonaId = null;
let providers = [];
let claudeModels = [];
let workspaces = [];
let defaults = null;
let selectedBackend = "api";
let activeStream = null;
let streamingBubble = null;

const personaListEl = document.getElementById("persona-list");
const chatHeaderEl = document.getElementById("chat-header");
const chatMessagesEl = document.getElementById("chat-messages");
const chatFormEl = document.getElementById("chat-form");
const chatTextEl = document.getElementById("chat-text");
const newAgentBtn = document.getElementById("new-agent-btn");

const modalEl = document.getElementById("new-agent-modal");
const modalNameEl = document.getElementById("new-agent-name");
const modalModelEl = document.getElementById("new-agent-model");
const modalCancelEl = document.getElementById("new-agent-cancel");
const modalCreateEl = document.getElementById("new-agent-create");
const modalWorkspaceEl = document.getElementById("new-agent-workspace");
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

async function fetchDefaults() {
  const res = await fetch("/api/defaults");
  return res.json();
}

async function fetchWorkspaces() {
  const res = await fetch("/api/workspaces");
  return res.json();
}

function ttlLabel(ms) {
  const min = Math.round(ms / 60000);
  return `${min}m`;
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
      <span class="ttl-dot ${p.ttlStatus}"></span>
      <span class="persona-name-block">
        <span class="persona-name">${p.blocked ? '<span class="blocked-flag">⚠</span>' : ""}${p.name}${p.alive ? "" : " (crashed)"}</span>
        <span class="persona-model">${modelLabel(p)} · ${workspaceLabel(p)}</span>
      </span>
      <span class="ttl-label">${ttlLabel(p.ttlRemainingMs)}</span>
    `;
    li.addEventListener("click", () => selectPersona(p));
    personaListEl.appendChild(li);
  }
}

async function refreshPersonas() {
  const personas = await fetchPersonas();
  renderPersonaList(personas);
  return personas;
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
      }
      streamingBubble = null;
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

backendBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    selectedBackend = btn.dataset.backend;
    backendBtns.forEach((b) => b.classList.toggle("active", b === btn));
    populateModelSelect();
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
  if (workspaces.length === 0) workspaces = await fetchWorkspaces();
  if (!defaults) defaults = await fetchDefaults();
  selectedBackend = "api";
  backendBtns.forEach((b) => b.classList.toggle("active", b.dataset.backend === "api"));
  populateModelSelect();
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
