import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import {
    DefaultResourceLoader,
    ModelRuntime,
    SessionManager,
    SettingsManager,
    createAgentSession,
} from "@earendil-works/pi-coding-agent";

import { createDevshellPiExtension, type DevshellPiToolSession } from "../../src/provider/pi/adapt/Bridge.ts";
import {
    PI_TMUX_TOOL_DOMAIN,
    PiToolExposureController,
} from "../../src/provider/pi/adapt/ToolExposure.ts";
import { PiAgentProfileCatalog } from "../../src/provider/pi/profile/Loader.ts";
import {
    PiSubagentRuntime,
    type PiAgentProfileCatalogLike,
} from "../../src/provider/pi/subagent/Runtime.ts";
import {
    attachPiSubagentTools,
    createPiSubagentTools,
    PI_SUBAGENT_TOOL_NAMES,
} from "../../src/provider/pi/subagent/Tools.ts";

type FauxContext = {
    systemPrompt?: string;
    messages: unknown[];
};

type FauxOptions = { signal?: AbortSignal };

type FauxModule = {
    fauxAssistantMessage(content: unknown, options?: { stopReason?: string }): unknown;
    fauxProvider(options?: Record<string, unknown>): {
        provider: unknown;
        getModel(): unknown;
        appendResponses(responses: Array<(context: FauxContext, options?: FauxOptions) => unknown | Promise<unknown> | unknown>): void;
        setResponses(responses: Array<(context: FauxContext, options?: FauxOptions) => unknown | Promise<unknown> | unknown>): void;
    };
    fauxToolCall(name: string, args: unknown): unknown;
};

async function loadFauxModule(): Promise<FauxModule> {
    const codingAgentEntry = fileURLToPath(
        import.meta.resolve("@earendil-works/pi-coding-agent"),
    );
    const codingAgentRoot = dirname(dirname(codingAgentEntry));
    const fauxPath = join(
        dirname(dirname(codingAgentRoot)),
        "@earendil-works",
        "pi-ai",
        "dist",
        "providers",
        "faux.js",
    );
    return (await import(pathToFileURL(fauxPath).href)) as FauxModule;
}

function record(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function effectiveToolNames(context: FauxContext): Set<string> {
    const names = new Set<string>();
    for (const message of context.messages) {
        const system = record(message);
        if (system?.role !== "system") continue;
        if (Array.isArray(system.toolsRemoved)) {
            for (const tool of system.toolsRemoved) {
                const name = record(tool)?.name;
                if (typeof name === "string") names.delete(name);
            }
        }
        if (Array.isArray(system.toolsAdded)) {
            for (const tool of system.toolsAdded) {
                const name = record(tool)?.name;
                if (typeof name === "string") names.add(name);
            }
        }
    }
    return names;
}

function lastUserText(context: FauxContext): string {
    for (let index = context.messages.length - 1; index >= 0; index -= 1) {
        const message = record(context.messages[index]);
        if (message?.role !== "user") continue;
        const content = message.content;
        if (typeof content === "string") return content;
        if (!Array.isArray(content)) return "";
        return content
            .flatMap((part) => {
                const item = record(part);
                return item?.type === "text" && typeof item.text === "string"
                    ? [item.text]
                    : [];
            })
            .join("\n");
    }
    return "";
}

function toolResultDetails(result: unknown): Record<string, unknown> {
    const details = record(record(result)?.details);
    assert.notEqual(details, undefined);
    return details!;
}

function toolByName(runtime: PiSubagentRuntime, name: string) {
    const tool = createPiSubagentTools(runtime).find((candidate) => candidate.name === name);
    assert.notEqual(tool, undefined, `missing ${name}`);
    return {
        execute(
            toolCallId: string,
            params: Parameters<NonNullable<typeof tool>["execute"]>[1],
        ) {
            return tool!.execute(
                toolCallId,
                params,
                undefined,
                undefined,
                {} as Parameters<NonNullable<typeof tool>["execute"]>[4],
            );
        },
    };
}

async function pollToolUntilIdle(
    runtime: PiSubagentRuntime,
    agent: string,
): Promise<Record<string, unknown>> {
    let cursor: number | undefined;
    for (let attempt = 0; attempt < 12; attempt += 1) {
        const details = toolResultDetails(
            await toolByName(runtime, "agent_poll").execute(
                `poll-until-idle-${attempt}`,
                {
                    agents: [agent],
                    ...(cursor === undefined ? {} : { cursor }),
                    timeoutMs: 1_000,
                },
            ),
        );
        const agents = details.agents as Array<Record<string, unknown>>;
        if (agents[0]?.activity === "idle") return details;
        assert.equal(typeof details.cursor, "number");
        cursor = details.cursor as number;
    }
    throw new Error(`Agent did not become idle: ${agent}`);
}

function createToolSession(callLog: Array<{ name: string; input: unknown }>): DevshellPiToolSession {
    const definitions = [
        ["file_read", { type: "object", properties: { files: { type: "array" } }, required: ["files"] }],
        ["tmux_run", { type: "object", properties: { command: { type: "string" } }, required: ["command"] }],
        ["tmux_read", { type: "object", properties: { task: { type: "string" } }, required: ["task"] }],
        ["tmux_input", { type: "object", properties: { task: { type: "string" }, text: { type: "string" } }, required: ["task", "text"] }],
        ["tmux_inspect", { type: "object", properties: {} }],
        ["tmux_manage", { type: "object", properties: { command: { type: "string" } }, required: ["command"] }],
    ] as const;
    const modelTools = definitions.map(([name, inputSchema]) => ({
        description: `${name} test tool`,
        inputSchema,
        name,
    }));
    return {
        target: { instance: "integration", workspace: "/workspace" },
        modelTools,
        tools: modelTools,
        async callTool(name: string, input: unknown) {
            callLog.push({ name, input });
            if (name === "file_read") {
                return {
                    files: [
                        {
                            content: "1:PROFILE_CHILD_MARKER",
                            path: "./marker.txt",
                            view: "content",
                        },
                    ],
                };
            }
            if (name === "tmux_manage" && record(input)?.command === "list") {
                return {
                    panes: [{ id: "%0", name: "main", status: "idle" }],
                };
            }
            if (name === "tmux_run") {
                return {
                    output: ["started"],
                    pane: { id: "%0", name: "main" },
                    task: { id: "task-integration", status: "running" },
                };
            }
            return {};
        },
        async close() {},
    } as unknown as DevshellPiToolSession;
}

test("real Pi runtime executes Profile/Subagent and state-driven Agent/Tmux exposure end to end", async () => {
    const root = await mkdtemp(join(tmpdir(), "devshell-pi-subagent-integration-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "workspace");
    await mkdir(join(agentDir, "agents"), { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(
        join(agentDir, "agents", "reviewer.md"),
        [
            "---",
            "name: reviewer",
            "models:",
            "  - missing/missing-model",
            "  - faux/faux-1",
            "---",
            "PROFILE_SENTINEL: reviewer instructions are active.",
        ].join("\n"),
        "utf8",
    );

    const fauxModule = await loadFauxModule();
    const faux = fauxModule.fauxProvider({ tokensPerSecond: 1_000_000 });
    const modelRuntime = await ModelRuntime.create({
        allowModelNetwork: false,
        authPath: join(agentDir, "auth.json"),
        modelsPath: join(agentDir, "models.json"),
    });
    modelRuntime.registerNativeProvider(faux.provider as never);
    const model = modelRuntime.getModel("faux", "faux-1");
    assert.notEqual(model, undefined);

    const runtimeForSubagents = new Proxy(modelRuntime, {
        get(target, property, receiver) {
            if (property === "checkAuth")
                return async () => ({ type: "api_key" as const });
            const value = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
        },
    });

    const toolCalls: Array<{ name: string; input: unknown }> = [];
    const tools = createToolSession(toolCalls);
    const profiles: PiAgentProfileCatalogLike = new PiAgentProfileCatalog(agentDir, tools);
    const guiSessions = new Set<string>();
    const exposureRef: { current?: PiToolExposureController } = {};
    const subagents = new PiSubagentRuntime({
        agentDir,
        gui: {
            attach(session) {
                guiSessions.add(session.sessionId);
                return session.sessionId;
            },
            detach(session) {
                guiSessions.delete(session.sessionId);
            },
        },
        localCwd: cwd,
        modelRuntime: runtimeForSubagents as never,
        onChildrenChanged: (hasAliveChildren) =>
            exposureRef.current?.setExpanded("agent", hasAliveChildren),
        profiles,
        sdk: {
            DefaultResourceLoader,
            ModelRuntime,
            SessionManager,
            SettingsManager,
            createAgentSession,
            getAgentDir: () => agentDir,
        } as never,
        tools,
    });

    const baseExtension = createDevshellPiExtension(tools, {
        closeSessionOnShutdown: false,
    });
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const resourceLoader = new DefaultResourceLoader({
        agentDir,
        cwd,
        extensionFactories: [
            {
                factory: async (pi) => {
                    await baseExtension(pi as never);
                    attachPiSubagentTools(pi as never, subagents);
                },
                hidden: true,
                name: "portable-devshell-integration",
            },
        ],
        settingsManager,
    });
    await resourceLoader.reload();
    const mainSessionManager = SessionManager.create(cwd, join(root, "main-sessions"));
    const { session: main } = await createAgentSession({
        agentDir,
        cwd,
        model,
        modelRuntime,
        noTools: "builtin",
        resourceLoader,
        sessionManager: mainSessionManager,
        settingsManager,
    });
    subagents.bindMain(() => ({
        model: main.agent.state.model,
        running: main.isStreaming,
        thinkingLevel: main.agent.state.thinkingLevel,
    }));
    const mainExposure = new PiToolExposureController(main as never, {
        agent: {
            expanded: PI_SUBAGENT_TOOL_NAMES,
            gateway: ["agent_spawn"],
        },
        tmux: PI_TMUX_TOOL_DOMAIN,
    });
    exposureRef.current = mainExposure;

    try {
        const initial = new Set(main.getActiveToolNames());
        assert.equal(initial.has("agent_spawn"), true);
        assert.equal(initial.has("agent_poll"), false);
        assert.equal(initial.has("tmux_run"), true);
        assert.equal(initial.has("tmux_read"), false);

        faux.setResponses([
            (context) => {
                const names = effectiveToolNames(context);
                assert.equal(names.has("agent_spawn"), false);
                assert.equal(names.has("tmux_run"), true);
                assert.equal(names.has("tmux_read"), false);
                return fauxModule.fauxAssistantMessage(
                    fauxModule.fauxToolCall("file_read", {
                        files: [{ path: "./marker.txt", view: "content" }],
                    }),
                    { stopReason: "toolUse" },
                );
            },
            (context) => {
                assert.equal(
                    context.messages.some((message) => record(message)?.role === "toolResult"),
                    true,
                );
                return fauxModule.fauxAssistantMessage("CHILD_FIRST_DONE");
            },
        ]);

        const spawnedResult = await toolByName(subagents, "agent_spawn").execute(
            "spawn-1",
            {
                fork: false,
                name: "reviewer",
                profile: "reviewer",
                task: "read the marker file",
            },
        );
        const spawned = toolResultDetails(spawnedResult);
        assert.equal(spawned.agent, "/root/main/reviewer");
        assert.equal(spawned.profile, "reviewer");
        assert.equal(spawned.model, "faux/faux-1");
        assert.equal(main.getActiveToolNames().includes("agent_poll"), true);
        assert.equal(main.getActiveToolNames().includes("agent_manage"), true);

        const polled = await pollToolUntilIdle(
            subagents,
            "/root/main/reviewer",
        );
        const agents = polled.agents as Array<Record<string, unknown>>;
        assert.equal(agents[0]?.activity, "idle");
        assert.equal(record(agents[0]?.lastTurn)?.result, "CHILD_FIRST_DONE");
        assert.equal(toolCalls.some((call) => call.name === "file_read"), true);

        faux.appendResponses([
            () => fauxModule.fauxAssistantMessage("CHILD_FOLLOWUP_DONE"),
        ]);
        await toolByName(subagents, "agent_interact").execute("interact-1", {
            agent: "/root/main/reviewer",
            interrupt: false,
            message: "follow up once",
        });
        const followup = await pollToolUntilIdle(
            subagents,
            "/root/main/reviewer",
        );
        const followupAgents = followup.agents as Array<Record<string, unknown>>;
        assert.equal(
            record(followupAgents[0]?.lastTurn)?.result,
            "CHILD_FOLLOWUP_DONE",
        );

        await assert.rejects(
            toolByName(subagents, "agent_spawn").execute("spawn-duplicate", {
                fork: false,
                name: "reviewer",
                task: "duplicate namespace",
            }),
            /Agent already exists/u,
        );

        faux.appendResponses([
            (context) => {
                const names = effectiveToolNames(context);
                assert.equal(names.has("tmux_run"), true);
                assert.equal(names.has("tmux_read"), false);
                return fauxModule.fauxAssistantMessage(
                    fauxModule.fauxToolCall("tmux_run", { command: "child-task" }),
                    { stopReason: "toolUse" },
                );
            },
            (context) => {
                const names = effectiveToolNames(context);
                assert.equal(names.has("tmux_read"), true);
                assert.equal(names.has("tmux_input"), true);
                assert.equal(names.has("tmux_manage"), true);
                return fauxModule.fauxAssistantMessage("CHILD_TMUX_DONE");
            },
        ]);
        await toolByName(subagents, "agent_interact").execute("interact-tmux", {
            agent: "reviewer",
            interrupt: false,
            message: "exercise child tmux",
        });
        const childTmux = await pollToolUntilIdle(
            subagents,
            "/root/main/reviewer",
        );
        const childTmuxAgents = childTmux.agents as Array<Record<string, unknown>>;
        assert.equal(
            record(childTmuxAgents[0]?.lastTurn)?.result,
            "CHILD_TMUX_DONE",
        );
        assert.equal(
            toolCalls.some(
                (call) =>
                    call.name === "tmux_run" &&
                    record(call.input)?.command === "child-task",
            ),
            true,
        );

        let managedBlockStarted!: () => void;
        const managedBlock = new Promise<void>((resolve) => {
            managedBlockStarted = resolve;
        });
        faux.appendResponses([
            async (_context, options) => {
                managedBlockStarted();
                await new Promise<never>((_resolve, reject) => {
                    const signal = options?.signal;
                    const abort = () =>
                        reject(signal?.reason ?? new Error("aborted"));
                    if (signal?.aborted === true) abort();
                    else signal?.addEventListener("abort", abort, { once: true });
                });
            },
            () => fauxModule.fauxAssistantMessage("CHILD_AFTER_MANAGE_INTERRUPT"),
        ]);
        await toolByName(subagents, "agent_interact").execute(
            "interact-manage-block",
            {
                agent: "reviewer",
                interrupt: false,
                message: "block for manage interrupt",
            },
        );
        await managedBlock;
        const managedInterrupt = toolResultDetails(
            await toolByName(subagents, "agent_manage").execute(
                "manage-interrupt",
                {
                    action: "interrupt",
                    agent: "reviewer",
                },
            ),
        );
        assert.equal(managedInterrupt.activity, "idle");
        assert.equal(record(managedInterrupt.lastTurn)?.outcome, "interrupted");
        await toolByName(subagents, "agent_interact").execute(
            "interact-after-manage-interrupt",
            {
                agent: "reviewer",
                interrupt: false,
                message: "resume after manage interrupt",
            },
        );
        const managedResume = await pollToolUntilIdle(
            subagents,
            "/root/main/reviewer",
        );
        const managedResumeAgents = managedResume.agents as Array<
            Record<string, unknown>
        >;
        assert.equal(
            record(managedResumeAgents[0]?.lastTurn)?.result,
            "CHILD_AFTER_MANAGE_INTERRUPT",
        );

        let blockedStarted!: () => void;
        const blocked = new Promise<void>((resolve) => {
            blockedStarted = resolve;
        });
        faux.appendResponses([
            async (_context, options) => {
                blockedStarted();
                await new Promise<never>((_resolve, reject) => {
                    const signal = options?.signal;
                    const abort = () => reject(signal?.reason ?? new Error("aborted"));
                    if (signal?.aborted === true) abort();
                    else signal?.addEventListener("abort", abort, { once: true });
                });
            },
            (context) => {
                assert.equal(lastUserText(context).includes("replacement"), true);
                return fauxModule.fauxAssistantMessage("CHILD_AFTER_INTERRUPT");
            },
        ]);
        await toolByName(subagents, "agent_interact").execute("interact-2", {
            agent: "reviewer",
            interrupt: false,
            message: "block until interrupted",
        });
        await blocked;

        const beforeMainWake = await subagents.poll({ timeoutMs: 0 });
        const wake = subagents.poll({ cursor: beforeMainWake.cursor, timeoutMs: 1_000 });
        setTimeout(() => subagents.notifyMainInput(), 10);
        const mainWake = await wake;
        assert.equal(
            mainWake.events.some(
                (event) => event.agent === "/root/main" && event.type === "input",
            ),
            true,
        );

        await toolByName(subagents, "agent_interact").execute("interact-3", {
            agent: "reviewer",
            interrupt: true,
            message: "replacement instruction",
        });
        const interruptedFollowup = await pollToolUntilIdle(
            subagents,
            "/root/main/reviewer",
        );
        const interruptedAgents = interruptedFollowup.agents as Array<Record<string, unknown>>;
        assert.equal(
            record(interruptedAgents[0]?.lastTurn)?.result,
            "CHILD_AFTER_INTERRUPT",
        );

        await toolByName(subagents, "agent_manage").execute("manage-1", {
            action: "terminate",
            agent: "reviewer",
        });
        assert.equal(main.getActiveToolNames().includes("agent_spawn"), true);
        assert.equal(main.getActiveToolNames().includes("agent_poll"), false);
        assert.equal(main.getActiveToolNames().includes("agent_manage"), false);
        await assert.rejects(
            toolByName(subagents, "agent_interact").execute("interact-dead", {
                agent: "reviewer",
                interrupt: false,
                message: "must fail",
            }),
            /Agent is terminated/u,
        );

        faux.appendResponses([
            (context) => {
                const names = effectiveToolNames(context);
                assert.equal(names.has("tmux_run"), true);
                assert.equal(names.has("tmux_read"), false);
                return fauxModule.fauxAssistantMessage(
                    fauxModule.fauxToolCall("tmux_run", { command: "sleep 1" }),
                    { stopReason: "toolUse" },
                );
            },
            (context) => {
                const names = effectiveToolNames(context);
                assert.equal(names.has("tmux_read"), true);
                assert.equal(names.has("tmux_input"), true);
                assert.equal(names.has("tmux_manage"), true);
                return fauxModule.fauxAssistantMessage("MAIN_TMUX_DONE");
            },
        ]);
        await main.prompt("exercise tmux exposure");
        assert.equal(toolCalls.some((call) => call.name === "tmux_run"), true);
        assert.equal(main.getActiveToolNames().includes("tmux_read"), true);
        assert.equal(main.getActiveToolNames().includes("tmux_manage"), true);

        await assert.rejects(
            toolByName(subagents, "agent_spawn").execute("spawn-fork", {
                fork: true,
                name: "forked",
                task: "unsupported",
            }),
            /fork=true is not supported yet/u,
        );
    } finally {
        await subagents.close().catch(() => undefined);
        mainExposure.close();
        main.dispose();
        await rm(root, { force: true, recursive: true });
    }
});
