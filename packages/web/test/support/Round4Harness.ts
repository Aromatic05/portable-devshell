import { PassThrough } from "node:stream";
import { createRound4Peer } from "./Round4Peer.js";
import { Endpoint, Rpc, StreamChannel, ToolCallViewModel, GoalViewModel, TodoViewModel,
    asInstanceName, createTaskTransport, createToolTransport, type ToolCallRecord, type GoalSnapshot } from "@portable-devshell/shared";
import { WebTestDomains } from "./DomainHarness.js";


export async function startRound4Peer(database: string) {
    const server = createRound4Peer(database);
    const outbound = new PassThrough(); const inbound = new PassThrough();
    const accepting = server.endpoint.accept(new StreamChannel(outbound, inbound));
    const endpoint = new Endpoint({ connectChannel: async () => new StreamChannel(inbound, outbound) });
    const rpc = new Rpc(await endpoint.connect("@control", "round4"));
    await accepting;
    return {
        endpoint,
        put: async (instance: string, kind: string, value: unknown, event?: unknown) =>
            await rpc.request("put", { instance, kind, value, event }),
        read: async (instance: string, kind: string) => await rpc.request("read", { instance, kind }),
        subscribers: async () => await rpc.request<Record<string, number>>("subscribers"),
        async close() {
            rpc.close(); endpoint.close(); server.close(); outbound.destroy(); inbound.destroy();
        },
    };
}

export function round4Domains(peer: Awaited<ReturnType<typeof startRound4Peer>>) {
    const harness = new WebTestDomains();
    harness.setInstances([{ name: "alpha" }, { name: "beta" }]);
    const toolCalls = new ToolCallViewModel({ cursor: async () => 0, refreshDelayMs: 0,
        transport: (instance) => createToolTransport(peer.endpoint, instance) });
    const goals = new GoalViewModel({ refreshDelayMs: 0,
        transport: (instance) => createTaskTransport(peer.endpoint, instance) });
    const todos = new Map(["alpha", "beta"].map((instance) =>
        [instance, new TodoViewModel(createTaskTransport(peer.endpoint, instance))] as const));
    Object.assign(harness.domains, { toolCalls, goals, todo: (instance: string) => todos.get(instance)! });
    return { harness, toolCalls, goals, todos,
        close() { toolCalls.close(); goals.close(); for (const todo of todos.values()) todo.close(); } };
}

export function round4Calls(count: number): ToolCallRecord[] {
    return Array.from({ length: count }, (_, index) => ({ instance: asInstanceName("alpha"), source: "mcp", input: { command: "deploy" },
        inputSummary: "deploy", workspace: "/temporary/alpha",
        callId: `call-${index.toString().padStart(3, "0")}`, ctxId: undefined,
        toolName: `operation_${index.toString().padStart(3, "0")}`,
        startedAt: new Date(Date.UTC(2026, 9, 20, 0, 0, index)).toISOString(),
        status: "completed", output: { stdout: `result-${index}` } }));
}

export function round4Goal(revision: number, status: "active" | "completed" = "active"): GoalSnapshot {
    return { autoContinueExhausted: false, continuationCount: 0, continuationDue: false,
        continuationDueAt: "2099-01-01T00:00:00Z", continuationPending: false, continuationUncertain: false,
        goalId: "goal-alpha", objective: "Verify round4 persistence",
        revision, status, workspace: "/temporary/alpha", steps: [
            { id: "step-1", text: "Inspect lifecycle", status: status === "completed" ? "completed" : "active" },
        ], createdAt: "2026-10-20T00:00:00Z", updatedAt: "2026-10-20T00:00:00Z",
        lastAgentActivityAt: "2026-10-20T00:00:00Z", lastProgressAt: "2026-10-20T00:00:00Z" };
}
