import assert from "node:assert/strict";
import test from "node:test";

import type { DevshellPiToolSession } from "../../src/provider/pi/adapt/Bridge.ts";
import type { PiAgentProfile } from "../../src/provider/pi/profile/Profile.ts";
import type {
    PiModelLike,
    PiModelRuntimeLike,
    PiSdkModule,
    PiSessionLike,
} from "../../src/provider/pi/runtime/Sdk.ts";
import {
    PiSubagentRuntime,
    type PiAgentProfileCatalogLike,
} from "../../src/provider/pi/subagent/Runtime.ts";

function deferred(): { promise: Promise<void>; resolve(): void } {
    let resolve = () => {};
    const promise = new Promise<void>((value) => {
        resolve = value;
    });
    return { promise, resolve };
}

class FakeSession implements PiSessionLike {
    readonly sessionId: string;
    readonly prompts: string[] = [];
    readonly followUps: string[] = [];
    readonly agent: NonNullable<PiSessionLike["agent"]>;
    disposed = false;
    aborted = 0;
    #streaming = false;
    #turn?: ReturnType<typeof deferred>;
    #listeners = new Set<(event: unknown) => void>();

    constructor(id: string, model?: PiModelLike) {
        this.sessionId = id;
        this.agent = {
            state: {
                messages: [],
                ...(model === undefined ? {} : { model }),
                thinkingLevel: "high",
            },
        };
    }

    get isStreaming(): boolean {
        return this.#streaming;
    }

    async abort(): Promise<void> {
        this.aborted += 1;
        this.#streaming = false;
        this.#turn?.resolve();
    }

    dispose(): void {
        this.disposed = true;
    }

    async followUp(text: string): Promise<void> {
        this.followUps.push(text);
    }

    async prompt(text: string): Promise<void> {
        this.prompts.push(text);
        this.#streaming = true;
        this.#turn = deferred();
        await this.#turn.promise;
    }

    async reload(): Promise<void> {}

    async waitForIdle(): Promise<void> {}

    subscribe(listener: (event: unknown) => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    resolveTurn(text: string): void {
        const messages = this.agent?.state?.messages;
        if (Array.isArray(messages)) {
            messages.push({
                role: "assistant",
                content: [{ type: "text", text }],
            });
        }
        this.#streaming = false;
        this.#turn?.resolve();
    }

    emitTool(name: string): void {
        for (const listener of this.#listeners)
            listener({ type: "tool_execution_start", toolName: name });
    }
}

function fakeRuntime() {
    const mainModel: PiModelLike = { id: "main", provider: "openai" };
    const childModel: PiModelLike = { id: "review", provider: "openai" };
    const main = new FakeSession("main", mainModel);
    const children: FakeSession[] = [];
    const modelRuntime: PiModelRuntimeLike = {
        async checkAuth() {
            return { type: "api_key" };
        },
        getModel(providerId, modelId) {
            return providerId === "openai" && modelId === "review"
                ? childModel
                : undefined;
        },
        getModels() {
            return [mainModel, childModel];
        },
        getProviders() {
            return [{ id: "openai" }];
        },
        async login() {},
        async logout() {},
    };
    const sdk = {
        DefaultResourceLoader: class {
            async reload() {}
        },
        ModelRuntime: { async create() { return modelRuntime; } },
        SessionManager: { create() { return {}; } },
        SettingsManager: {
            create() {
                return {
                    async flush() {},
                    getDefaultModel() { return undefined; },
                    getDefaultProvider() { return undefined; },
                    getDefaultThinkingLevel() { return undefined; },
                    setDefaultModelAndProvider() {},
                    setDefaultThinkingLevel() {},
                };
            },
        },
        getAgentDir() { return "/tmp/pi-agent"; },
        async createAgentSession(options: Record<string, unknown>) {
            const session = new FakeSession(
                `child-${children.length + 1}`,
                options.model as PiModelLike | undefined,
            );
            children.push(session);
            return { session };
        },
    } as unknown as PiSdkModule;
    const profile: PiAgentProfile = {
        candidateModels: ["openai/review"],
        filePath: ".pi/agents/reviewer.md",
        name: "reviewer",
        prompt: "Review only the delegated task.",
        source: "project",
    };
    const profiles: PiAgentProfileCatalogLike = {
        async get(name) {
            return name === profile.name ? profile : undefined;
        },
        async list() {
            return [profile];
        },
    };
    const tools = {
        target: { instance: "local", workspace: "workspace" },
        modelTools: [],
        tools: [],
        async callTool() { return null; },
        async close() {},
    } as DevshellPiToolSession;
    const attached: PiSessionLike[] = [];
    const detached: PiSessionLike[] = [];
    const runtime = new PiSubagentRuntime({
        agentDir: "/tmp/pi-agent",
        gui: {
            attach(session) {
                attached.push(session);
                return session.sessionId;
            },
            detach(session) {
                detached.push(session);
            },
        },
        localCwd: "/tmp/workspace",
        modelRuntime,
        profiles,
        sdk,
        tools,
    });
    runtime.bindMain(main);
    return { attached, children, detached, main, runtime };
}

test("Pi Subagent runtime spawns an isolated profiled child and keeps /root/main responsive while polling", async () => {
    const harness = fakeRuntime();
    const spawned = await harness.runtime.spawn({
        name: "review_auth",
        profile: "reviewer",
        task: "Review authentication changes",
    });

    assert.equal(spawned.agent, "/root/main/review_auth");
    assert.equal(spawned.profile, "reviewer");
    assert.equal(spawned.model, "openai/review");
    assert.equal(spawned.activity, "running");
    assert.deepEqual(harness.children[0]?.prompts, ["Review authentication changes"]);

    const baseline = await harness.runtime.poll({ timeoutMs: 0 });
    assert.equal(baseline.timedOut, true);
    const waiting = harness.runtime.poll({
        cursor: baseline.cursor,
        timeoutMs: 1_000,
    });
    harness.runtime.notifyMainInput();
    const userWake = await waiting;
    assert.equal(userWake.timedOut, false);
    assert.equal(
        userWake.events.some(
            (event) => event.agent === "/root/main" && event.type === "input",
        ),
        true,
    );

    await harness.runtime.interact({
        agent: "review_auth",
        interrupt: false,
        message: "Also check reconnect handling",
    });
    assert.deepEqual(harness.children[0]?.followUps, ["Also check reconnect handling"]);

    harness.children[0]?.emitTool("file_grep");
    const progress = await harness.runtime.poll({
        cursor: userWake.cursor,
        timeoutMs: 1_000,
    });
    assert.equal(progress.events.at(-1)?.detail, "file_grep");

    harness.children[0]?.resolveTurn("No blocking issue found.");
    await new Promise<void>((resolve) => setImmediate(resolve));
    const completed = await harness.runtime.poll({
        cursor: progress.cursor,
        timeoutMs: 1_000,
    });
    assert.equal(completed.agents[0]?.activity, "idle");
    assert.equal(completed.agents[0]?.lastTurn?.outcome, "completed");
    assert.equal(completed.agents[0]?.lastTurn?.result, "No blocking issue found.");

    const terminated = await harness.runtime.manage({
        action: "terminate",
        agent: "/root/main/review_auth",
    });
    assert.equal(terminated.lifecycle, "terminated");
    assert.equal(harness.children[0]?.disposed, true);
    assert.equal(harness.detached.length, 1);
});

test("Pi Subagent runtime reserves fork=true for future full-context cloning", async () => {
    const harness = fakeRuntime();
    await assert.rejects(
        harness.runtime.spawn({
            fork: true,
            name: "forked",
            task: "inherit everything",
        }),
        /not supported yet/u,
    );
});
