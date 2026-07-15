// Quick verification script: opens the SSE stream for a persona, sends a
// message designed to produce a longer response, and logs each delta with a
// timestamp so we can see whether chunks actually arrive incrementally
// (streaming) rather than all at once at the end (not streaming).
const personaId = process.argv[2];
const backend = process.argv[3] || "claude-code";

const res = await fetch(`http://127.0.0.1:5173/api/personas/${personaId}/stream`);
const reader = res.body.getReader();
const decoder = new TextDecoder();
const start = Date.now();

(async () => {
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const evt = JSON.parse(line.slice(6));
      const t = Date.now() - start;
      if (evt.type === "delta") console.log(`[+${t}ms] delta: ${JSON.stringify(evt.text)}`);
      else console.log(`[+${t}ms] ${evt.type}:`, evt.text?.slice(0, 60));
      if (evt.type === "done") process.exit(0);
    }
  }
})();

await new Promise((r) => setTimeout(r, 300)); // let the stream connect first

await fetch(`http://127.0.0.1:5173/api/personas/${personaId}/messages`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ text: "Count from one to twenty, one number per line, nothing else." }),
});
