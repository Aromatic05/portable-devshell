import { Instance } from "@portable-devshell/core/instance";
import { ProcessSubscriptionManager, createToolCallRuntime, type InstanceEventSource, type JsonValue, type ToolCallContext, type ToolCallDispatchRequest, type ToolCallQuery } from "@portable-devshell/shared";
import type { TerminalProcess } from "../../../core/src/terminal/Api.ts";
import { TerminalSessionService } from "../../../core/src/terminal/Service.ts";

type InstanceFields = ConstructorParameters<typeof Instance>[0];

export function createTestInstance(
    worker: InstanceFields["worker"],
    overrides: Partial<Omit<InstanceFields, "worker">> = {},
): Instance {
    return new Instance({
        config: {
            enabled: true,
            mcpEnabled: false,
            mcpPath: "",
            modelExtensions: [],
            name: "alpha",
            provider: "local",
        },
        eventLog: {
            async flush() {},
            port: {},
        },
        state: {
            approval: { setPolicy() {} },
            async close() {},
            async prepareRetirement() {},
            async retire() {},
        },
        subscriptions: {
            close() {},
            unsubscribeConnection() {},
        },
        worker,
        ...overrides,
    } as never);
}

export function createTestInstanceDescriptor(
    worker: InstanceFields["worker"],
    overrides: { name?: string; terminalProcess?: TerminalProcess } = {},
): Instance {
    const name = overrides.name ?? "alpha";
    // The transport integration tests exercise a fake Worker but real Control
    // Route, ToolCall and TerminalSession protocols. Wrap that Worker in the
    // current Instance capability surface instead of pretending its old flat
    // methods are a full WorkerInstance and crashing during host registration.
    const transport = worker as unknown as {
        snapshot(): { lastSeq: number; ready: boolean; name: string };
        subscribe(fromSeq?: number): ReturnType<InstanceEventSource["subscribe"]>;
        refreshStatus?(): Promise<JsonValue>;
        startInteractive?(session: unknown): Promise<JsonValue>;
        stop?(): Promise<JsonValue>;
        readLogs?(query: { fromSeq?: number; limit?: number; maxDecodedBytes?: number }): Promise<JsonValue>;
        callTool?(toolName: string, input: JsonValue, options: ToolCallContext): Promise<JsonValue>;
        readToolCalls?(query: ToolCallQuery): JsonValue[];
        listApprovals?(): JsonValue[];
        getApproval?(approvalId: string): JsonValue;
        decideApproval?(approvalId: string, decision: JsonValue): JsonValue;
    };
    const subscriptions = new ProcessSubscriptionManager();
    const sessions = new TerminalSessionService();
    const target = {
        dispatch: async (request: ToolCallDispatchRequest) => {
            if (transport.callTool === undefined) throw new Error("Fake Worker has no ToolCall executor.");
            return await transport.callTool(request.value.toolName, request.value.payload, request.value.context);
        },
    };
    const toolCalls = createToolCallRuntime({ resolveTarget: () => target });
    const snapshot = () => transport.snapshot();
    const environment = {
        async prepareWorkspace(workspace: string) {
            return {
                projectMemoryAgentFile: `${workspace}/AGENTS.md`,
                projectMemoryDirectory: workspace,
                projectMemoryPresent: false,
                temporaryDirectory: `${workspace}/.tmp`,
                workspace,
            };
        },
    };
    const runtimeWorker = {
        execution: { environment },
        supervision: {
            snapshot,
            state: { subscribe: (fromSeq?: number) => transport.subscribe(fromSeq) },
            recovery: { refreshStatus: () => transport.refreshStatus?.() ?? Promise.resolve(snapshot()) },
            lifecycle: {
                startInteractive: (session: unknown) => transport.startInteractive?.(session) ?? Promise.resolve(snapshot()),
                stop: () => transport.stop?.() ?? Promise.resolve(snapshot()),
            },
            ownership: { clearOwned() {}, markOwned() {} },
        },
    };
    return new Instance({
        config: {
            enabled: true,
            name,
            provider: "local",
        },
        eventLog: {
            async flush() {},
            port: {},
        },
        state: {
            approval: {
                setPolicy() {},
                api: {
                    listApprovals: async () => transport.listApprovals?.() ?? [],
                    listPendingApprovals: async () => [],
                    getApproval: async (id: string) => transport.getApproval?.(id) ?? null,
                    decideApproval: async (id: string, decision: JsonValue) => transport.decideApproval?.(id, decision) ?? null,
                },
            },
            task: {
                api: {
                    goal: { list: async () => [], read: async () => undefined },
                    todo: { read: async () => undefined, delete: async () => undefined },
                    wait: { list: async () => [] },
                },
            },
            terminal: {
                api: { open: async () => {
                    if (overrides.terminalProcess === undefined)
                        throw new Error("No terminal process configured in Control transport fixture.");
                    return overrides.terminalProcess;
                } },
                sessions: { api: sessions },
            },
            tools: {
                readLogs: async (query: { fromSeq?: number; limit?: number; maxDecodedBytes?: number }) =>
                    await transport.readLogs?.(query) ?? [],
                readToolCalls: async (query: ToolCallQuery) => transport.readToolCalls?.(query) ?? [],
                readToolCallFailureSummary: async () => ({ count: 0 }),
                openSession: async (workspace: string) => ({ workspace }),
                releaseSession: async () => undefined,
            },
            toolCalls,
            toolDefinitions: { list: () => [] },
            target: () => target,
            async close() { toolCalls.close(); sessions.close(); },
            async prepareRetirement() {},
            async retire() { toolCalls.close(); sessions.close(); },
        },
        subscriptions,
        worker: runtimeWorker,
    } as never);
}
