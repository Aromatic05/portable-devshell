import assert from "node:assert/strict";
import test from "node:test";

import type { Channel } from "@portable-devshell/shared";
import type { Envelope } from "../../../src/transport/envelope/Codec.ts";
import type { Packet } from "../../../src/transport/packet/Packet.ts";
import type { EnvelopeCodec } from "../../../src/transport/envelope/Codec.ts";
import { Route } from "../../../src/transport/endpoint/route/Route.ts";

class TestPeer {
    readonly sent: Envelope[] = [];
    readonly channel = { closed: false } as Channel;
    readonly codec = this as unknown as EnvelopeCodec;
    readonly #listeners = new Set<(value: Envelope) => void>();
    readonly #closed = new Set<() => void>();

    onEnvelope(listener: (value: Envelope) => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }
    onClose(listener: () => void): () => void {
        this.#closed.add(listener);
        return () => this.#closed.delete(listener);
    }
    async send(envelope: Envelope): Promise<void> {
        this.sent.push(envelope);
    }
    close(): void {
        for (const listener of this.#closed) listener();
        this.#closed.clear();
    }
    incoming(host = "control"): void {
        this.#emit(host, "core", "core", { protocol: "event", name: "probe" });
    }
    promote(host = "control"): void {
        this.#emit(host, "transport", "transport", {
            protocol: "rpc", type: "request", id: "promote-1", method: "transport.peer.promote",
        });
    }
    #emit(host: string, sourcePort: string, destPort: string, packet: Packet): void {
        const envelope = {
            source: { host, port: sourcePort },
            dest: { host: "worker", port: destPort },
            packet,
        };
        for (const listener of this.#listeners) listener(envelope);
    }
}

function fixture() {
    const route = new Route();
    const authorized = new Set<Channel>();
    const core = route.bind("worker", "core");
    const notifications = route.bind("worker", "notifications");
    const peers: TestPeer[] = [];
    const accept = () => {
        const peer = new TestPeer();
        route.attach(peer.codec, peer.channel, undefined, true,
            (_host, channel) => authorized.has(channel));
        peers.push(peer);
        return peer;
    };
    const send = async () => await notifications.send(
        { host: "control", port: "notifications" }, { protocol: "event", name: "changed" },
    );
    return { accept, authorized, core, notifications, peers, send };
}

function lastProtocol(peer: TestPeer): unknown {
    const packet = peer.sent.at(-1)?.packet;
    return typeof packet === "object" && packet !== null && "protocol" in packet
        ? packet.protocol
        : undefined;
}

test("unverified candidates never become active when the old channel disconnects or another packet arrives", async () => {
    const f = fixture();
    const old = f.accept();
    const candidate = f.accept();
    old.incoming();
    candidate.incoming();
    await f.send();
    assert.equal(old.sent.length, 1);
    assert.equal(candidate.sent.length, 0);

    old.close();
    assert.equal(f.notifications.canReach({ host: "control", port: "notifications" }), false);
    await assert.rejects(f.send(), /No route/u);
    candidate.incoming();
    assert.equal(f.notifications.canReach({ host: "control", port: "notifications" }), false);

    candidate.promote();
    assert.equal((candidate.sent.at(-1)?.packet as { error?: { code: string } }).error?.code,
        "transport.peerPromotionUnverified");
    assert.equal(f.notifications.canReach({ host: "control", port: "notifications" }), false);

    f.authorized.add(candidate.channel);
    candidate.promote();
    await f.send();
    assert.equal(lastProtocol(candidate), "event");
    old.close(); candidate.close(); f.core.close(); f.notifications.close();
});

test("previously active channels remain valid fallback peers after a verified replacement disconnects", async () => {
    const f = fixture();
    const old = f.accept();
    const candidate = f.accept();
    old.incoming();
    candidate.incoming();
    f.authorized.add(candidate.channel);
    candidate.promote();
    await f.send();
    assert.equal(lastProtocol(candidate), "event");

    f.authorized.clear();
    candidate.close();
    await f.send();
    assert.equal(lastProtocol(old), "event",
        "the original active peer needs no second authorization");
    old.close(); f.core.close(); f.notifications.close();
});
