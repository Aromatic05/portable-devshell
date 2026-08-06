import { describe, expect, it } from "vitest";
import type { Channel } from "@portable-devshell/shared/browser";

import { createWebClients } from "../src/client/WebClients.js";

describe("web client transport", () => {
    it("reports an unexpected persistent transport close", async () => {
        const channel = new ReplyChannel();
        const clients = createWebClients(async () => channel);
        const failures: string[] = [];
        clients.onTransportClose((error) => failures.push(error.message));
        await clients.service.hello();

        channel.close(new Error("transport lost"));

        expect(failures).toEqual(["transport lost"]);
    });
});

class ReplyChannel implements Channel {
    closed = false;
    private readonly frames = new Set<(frame: Uint8Array) => void>();
    private readonly closes = new Set<(error?: Error) => void>();

    async send(frame: Uint8Array): Promise<void> {
        const request = JSON.parse(new TextDecoder().decode(frame)) as {
            destination: string;
            id: string;
            name: string;
        };
        const reply = {
            destination: request.destination,
            from: "server",
            id: `reply-${request.id}`,
            name: request.name,
            payload: {
                capabilities: ["request", "stream", "streamResume"],
                protocolVersion: 1,
            },
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

    close(error?: Error): void {
        this.closed = true;
        for (const listener of this.closes) listener(error);
    }
}
