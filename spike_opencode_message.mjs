import { createOpencodeClient } from "@opencode-ai/sdk";

const client = createOpencodeClient({ baseUrl: "http://127.0.0.1:4197" });

const session = await client.session.create({ body: { title: "symposion message spike" } });
const sessionID = session.data.id;
console.log("session:", sessionID);

const result = await client.session.prompt({
  path: { id: sessionID },
  body: {
    model: { providerID: "opencode", modelID: "mimo-v2.5-free" },
    parts: [{ type: "text", text: "Reply with exactly one word: pong" }],
  },
});

console.log(JSON.stringify(result, null, 2).slice(0, 2000));
