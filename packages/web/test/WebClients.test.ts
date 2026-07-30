import { describe, expect, it } from "vitest";
import { createWebClients } from "../src/client/WebClients.js";

describe("typed web client routing", () => {
    it("uses canonical service, instance, runtime, tool, and mcp operations", async () => { const channel = new ReplyChannel(); const clients = createWebClients({ channelProvider: { connect: async () => channel } }); await clients.service.status(); await clients.instance.list(); await clients.runtime.readLogs("demo", { limit: 5 }); await clients.tool.listApprovals("demo"); await clients.mcp.listApprovals(); expect(channel.operations).toEqual(["service.status", "instance.list", "runtime.readLogs", "tool.listApprovals", "mcp.listApprovals"]); });
});
class ReplyChannel {
    closed = false; operations: string[] = []; private frames = new Set<(frame: Uint8Array) => void>(); private closes = new Set<(error?: Error) => void>();
    async send(frame: Uint8Array): Promise<void> { const request = JSON.parse(new TextDecoder().decode(frame)) as { id: string; name: string; destination: string }; this.operations.push(request.name); const reply = { id: `reply-${request.id}`, replyTo: request.id, from: "server", to: "web", destination: request.destination, name: request.name, payload: request.name === "service.status" ? { ok: true, instanceCount: 0 } : [] }; queueMicrotask(() => this.frames.forEach((listener) => listener(new TextEncoder().encode(JSON.stringify(reply))))); }
    onFrame(listener: (frame: Uint8Array) => void): () => void { this.frames.add(listener); return () => this.frames.delete(listener); }
    onClose(listener: (error?: Error) => void): () => void { this.closes.add(listener); return () => this.closes.delete(listener); }
    close(): void { this.closed = true; this.closes.forEach((listener) => listener()); }
}
