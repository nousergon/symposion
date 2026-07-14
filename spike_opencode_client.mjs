import { createOpencodeClient } from "@opencode-ai/sdk";

const client = createOpencodeClient({ baseUrl: "http://127.0.0.1:4197" });

console.log("--- providers ---");
const providers = await client.config.providers();
console.log(JSON.stringify(providers, null, 2).slice(0, 1000));

console.log("--- creating a session ---");
const session = await client.session.create({ body: { title: "symposion spike" } });
console.log(JSON.stringify(session, null, 2));

console.log("--- listing sessions ---");
const sessions = await client.session.list();
console.log(`session count: ${sessions.data?.length ?? sessions.length}`);
