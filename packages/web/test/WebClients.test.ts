import { describe, expect, it } from "vitest";
import type {
    ChannelProvider,
    FrameChannel,
} from "@portable-devshell/shared/browser";

import { createWebClients } from "../src/client/WebClients.js";

describe("typed web client routing", () => {
    it("negotiates service.hello before using canonical control operations", async () => {
        const channel = new ReplyChannel();
        const provider: ChannelProvider = { connect: async () => channel };
        const clients = createWebClients(provider);

        const hello = await clients.service.hello();
        await clients.service.status();
        await clients.instance.list();
        await clients.runtime.readLogs("demo", { limit: 5 });
        await clients.tool.listApprovals("demo");
        await clients.mcp.status();
        await clients.mcp.listApprovals();

        expect(hello.protocolVersion).toBe(1);
        expect(channel.operations).toEqual([
            "service.hello",
            "service.status",
            "instance.list",
            "runtime.readLogs",
            "tool.listApprovals",
            "mcp.status",
            "mcp.listApprovals",
        ]);
        expect(channel.payloads[0]).toEqual({
            clientKind: "web",
            maxProtocolVersion: 1,
            minProtocolVersion: 1,
        });
    });
});

class ReplyChannel implements FrameChannel {
    closed = false;
    operations: string[] = [];
    payloads: unknown[] = [];
    private readonly frames = new Set<(frame: Uint8Array) => void>();
    private readonly closes = new Set<(error?: Error) => void>();

    async send(frame: Uint8Array): Promise<void> {
        const request = JSON.parse(new TextDecoder().decode(frame)) as {
            destination: string;
            id: string;
            name: string;
            payload?: unknown;
        };
        this.operations.push(request.name);
        this.payloads.push(request.payload);
        const payload =
            request.name === "service.hello"
                ? {
                      capabilities: ["request", "stream", "streamResume"],
                      protocolVersion: 1,
                  }
                : request.name === "service.status"
                  ? { instanceCount: 0, ok: true }
                  : [];
        const reply = {
            destination: request.destination,
            from: "server",
            id: `reply-${request.id}`,
            name: request.name,
            payload,
            replyTo: request.id,
            to: "web",
        };
        queueMicrotask(() => {
            const encoded = new TextEncoder().encode(JSON.stringify(reply));
            for (const listener of this.frames) listener(encoded);
        });
    }

    onFrame(listener: (frame: Uint8Array) => void): () => void {
        this.frames.add(listener);
        return () => this.frames.delete(listener);
    }

    onClose(listener: (error?: Error) => void): () => void {
        this.closes.add(listener);
        return () => this.closes.delete(listener);
    }

    close(): void {
        this.closed = true;
        for (const listener of this.closes) listener();
    }
}
