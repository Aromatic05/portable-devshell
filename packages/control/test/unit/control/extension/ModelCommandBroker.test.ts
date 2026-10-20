import assert from "node:assert/strict";
import test from "node:test";

import type { Instance } from "@portable-devshell/core";
import { Endpoint, Rpc } from "@portable-devshell/shared";
import { ModelCommandBroker } from "../../../../src/extension/api/point/cli/command/Broker.ts";

const request = {
    argv: ["memory"], ctxId: "ctx-a", parentCallId: "parent-a",
    sessionId: "session-a", taskId: "task-a", workspace: "/repo",
};
const record = {
    callId: "parent-a", ctxId: "ctx-a", source: "mcp", workspace: "/repo",
    toolName: "tmux_run", status: "completed", output: { task: { id: "task-a" } },
};

async function exercise(parent: Record<string, unknown>) {
    const endpoint = new Endpoint({ host: "worker-a" });
    const rpc = new Rpc(endpoint.bind("tool"), {
        listCalls: async (message) => {
            assert.deepEqual(message, { callIds: ["parent-a"], includeOutput: true });
            return [parent];
        },
    });
    const opened: ((value: typeof request) => void)[] = [];
    const effects: string[] = [];
    const sessions = {
        onOpen(listener: (value: typeof request) => void) { opened.push(listener); return () => {}; },
        onClose() { return () => {}; },
        async output() { effects.push("output"); },
        async complete() { effects.push("complete"); },
    };
    const instance = {
        config: { name: "worker-a", modelExtensions: ["comment"] },
        commandSessions: sessions,
    } as unknown as Instance;
    let executions = 0;
    const broker = new ModelCommandBroker({
        changes: { onChange: () => () => {} },
        commands: {
            list: () => [{ id: "memory", extensionId: "comment" }],
            async command() { executions += 1; return { kind: "text", text: "ok" }; },
        } as never,
        contexts: { registry: {
            async validateForInstance() { return { environments: [{ instance: "worker-a", workspace: "/repo" }] }; },
            referenceInstance() { return "worker-a"; },
        } } as never,
        endpoint,
        instances: { list: () => [instance] },
    });
    opened[0]!(request);
    await new Promise<void>((resolve) => setImmediate(resolve));
    broker.close();
    rpc.close();
    return { effects, executions };
}

test("Model command broker rejects forged parent provenance before command effects", async () => {
    for (const forged of [
        { ...record, source: "extension" },
        { ...record, ctxId: "ctx-other" },
        { ...record, workspace: "/other" },
        { ...record, toolName: "bash_run" },
        { ...record, output: { task: { id: "task-other" } } },
    ]) {
        const result = await exercise(forged);
        assert.equal(result.executions, 0, "denied provenance must not invoke or mutate command state");
        assert.deepEqual(result.effects, ["output", "complete"], "the rejected session must receive its error and close");
    }
});

test("Model command broker accepts completed tmux parent only for its returned task identity", async () => {
    const result = await exercise(record);
    assert.equal(result.executions, 1);
    assert.deepEqual(result.effects, ["output", "complete"]);
});
