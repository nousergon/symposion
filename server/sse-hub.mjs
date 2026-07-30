// Tiny per-persona pub/sub over SSE. One persona can have multiple browser
// tabs subscribed; each publish() fans out to all of them.
export class SseHub {
  constructor() {
    /** @type {Map<string, Set<import('express').Response>>} */
    this.subscribers = new Map();
  }

  subscribe(personaId, res) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");

    if (!this.subscribers.has(personaId)) this.subscribers.set(personaId, new Set());
    this.subscribers.get(personaId).add(res);

    res.on("close", () => {
      this.subscribers.get(personaId)?.delete(res);
    });
  }

  publish(personaId, event) {
    const set = this.subscribers.get(personaId);
    if (!set || set.size === 0) return;
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of set) res.write(line);
  }
}
