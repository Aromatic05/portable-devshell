import { expect, it, vi } from "vitest";
import { InstanceConfigViewModel, MessageHistoryViewModel, MessageViewModel } from "@portable-devshell/shared";

import { WebDomainSession } from "../../src/app/domain/Session.js";

const create = () => new WebDomainSession({ connectChannel: async () => { throw new Error("network not used"); } });

function mockDomainReads(session: WebDomainSession): void {
    Object.assign(session.instances, { list: async () => {}, refresh: async () => {} });
    Object.assign(session.context, { load: async () => {}, refresh: async () => {} });
    Object.assign(session.artifact, { load: async () => {}, refresh: async () => {} });
    Object.assign(session.config, { get: async () => {}, refresh: async () => {} });
    Object.assign(session.extension, { refreshCatalogs: async () => {} });
    Object.assign(session.messageHistory, { load: async () => {} });
    Object.assign(session.messagePreferences, { refresh: async () => {} });
    Object.assign(session.overview, { refresh: async () => {} });
    Object.assign(session.mcp, { load: async () => {}, refresh: async () => {} });
}

it("a disposed domain Session never starts pollers when its pending initial load finishes", async () => {
    const session = create();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    mockDomainReads(session);
    Object.assign(session.server, { connect: async () => {} });
    Object.assign(session.config, { get: async () => await blocked });
    const authStart = vi.spyOn(session.mcp, "start");
    const overviewStart = vi.spyOn(session.overview, "start");
    const old = session.load();
    await Promise.resolve();
    session.close();
    release();
    await old;
    expect(authStart).not.toHaveBeenCalled();
    expect(overviewStart).not.toHaveBeenCalled();
});

it("a successful reconnect after an offline bootstrap arms Auth and Overview polling", async () => {
    const session = create();
    mockDomainReads(session);
    const authStart = vi.spyOn(session.mcp, "start");
    const overviewStart = vi.spyOn(session.overview, "start");
    Object.assign(session.server, {
        connect: async () => { throw new Error("Control offline during bootstrap"); },
        reconnect: async () => {},
    });
    try {
        await expect(session.load()).rejects.toThrow("Control offline");
        await session.reconnect();
        expect(authStart).toHaveBeenCalledOnce();
        expect(overviewStart).toHaveBeenCalledOnce();
    } finally { session.close(); }
});

it("single-Instance release clears both Message projections and closes their old streams", async () => {
    const session = create();
    let closed = 0;
    let generation = 0;
    const data = { id: "old", ctxId: "old", instance: "alpha", text: "old", status: "pending", kind: "comment", createdAt: "2026-01-01T00:00:00Z" };
    const transport = {
        async listContextMessages() { return generation === 0 ? { lastSeq: 99, messages: [data] } : { lastSeq: 0, messages: [] }; },
        async listMessageEntries() { return generation === 0 ? { lastSeq: 99, entries: [data] } : { lastSeq: 0, entries: [] }; },
        async subscribe() { return { next: async () => await new Promise<never>(() => {}), close() { closed++; } }; },
    };
    const messages = new MessageViewModel({ transport: transport as never });
    const history = new MessageHistoryViewModel({ transport: transport as never });
    Object.assign(session, { messages, messageHistory: history });
    try {
        await Promise.all([messages.load(["alpha"]), history.load(["alpha"])]);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(messages.state.instances.alpha?.messages).toHaveLength(1);
        expect(history.state.instances.alpha?.entries).toHaveLength(1);
        session.releaseInstance("alpha");
        expect(messages.state.instances.alpha).toBeUndefined();
        expect(history.state.instances.alpha).toBeUndefined();
        expect(closed).toBe(2);
        generation = 1;
        await Promise.all([messages.load(["alpha"]), history.load(["alpha"])]);
        expect(messages.state.instances.alpha?.messages).toEqual([]);
        expect(history.state.instances.alpha?.entries).toEqual([]);
        expect(history.state.instances.alpha?.lastSeq).toBe(0);
    } finally { session.close(); }
});

it("a catalog removal from another client releases the old Instance without a local delete call", () => {
    const subscribe = InstanceConfigViewModel.prototype.subscribe;
    let published!: () => void;
    const spy = vi.spyOn(InstanceConfigViewModel.prototype, "subscribe").mockImplementation(function (this: InstanceConfigViewModel, listener) {
        published = listener;
        return subscribe.call(this, listener);
    });
    const session = create();
    spy.mockRestore();
    let names = [{ name: "alpha" }];
    Object.defineProperty(session.instances, "state", {
        configurable: true,
        get: () => ({ loading: false, refreshing: false, supported: true, instances: names }),
    });
    const oldMessage = { id: "old", ctxId: "old", instance: "alpha", text: "old", status: "pending", createdAt: "2026-01-01T00:00:00Z" };
    try {
        published();
        session.messages.mergeMessage("alpha", oldMessage as never);
        expect(session.messages.state.instances.alpha?.messages).toHaveLength(1);
        names = [];
        published();
        expect(session.messages.state.instances.alpha).toBeUndefined();
    } finally { session.close(); }
});
