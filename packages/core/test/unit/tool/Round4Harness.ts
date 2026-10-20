import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asInstanceName, createToolCallRuntime, type JsonValue } from "@portable-devshell/shared";
import { createAuditRuntime } from "../../../src/audit/index.ts";
import { WorkerInstanceTool } from "../../../src/toolcall/execution/Tool.ts";
import { ToolCallHistory } from "../../../src/toolcall/execution/record/History.ts";
import { WorkerToolCallScheduler } from "../../../src/toolcall/execution/Scheduler.ts";
import { ApprovalService } from "../../../src/approval/execution/Service.ts";
import { InstanceApprovalStore } from "../../../src/approval/Store.ts";

export function barrier<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

// Real scheduler, terminal audit, and approval persistence. Only the leaf tool
// implementation is supplied by each test; it can perform actual local I/O.
export async function round4Target() {
    const directory = await mkdtemp(join(tmpdir(), "round4-tool-audit-"));
    const databasePath = join(directory, "audit.sqlite3");
    const instanceName = asInstanceName("round4");
    const audit = createAuditRuntime({ instanceName, filePath: databasePath, eventBufferSize: 1000 });
    const events: Array<{ type: string; data?: JsonValue }> = [];
    let seq = 0;
    const appendEvent = async (type: string, data?: JsonValue) => {
        await audit.api.events.append({ type, data, seq: ++seq,
            at: new Date().toISOString(), instanceName });
        events.push({ type, data });
    };
    const history = new ToolCallHistory(instanceName, audit.api.toolCalls);
    const scheduler = new WorkerToolCallScheduler({
        maxRunning: 64, maxRunningPerSession: 64, queueDepth: 128,
        queueDepthPerSession: 128, queueTimeoutMs: 30_000, byTool: {},
    });
    const tool = new WorkerInstanceTool({
        appendEvent, assertReady() {}, instanceName, logStore: audit.api.logs,
        toolCallHistory: history, toolCallScheduler: scheduler,
        toolInvoker: { async invoke() { throw new Error("Test must install a leaf executor"); } },
    });
    const runtime = createToolCallRuntime({ resolveTarget: () => tool.target() });
    const approval = new ApprovalService({
        instanceName, store: new InstanceApprovalStore(audit.api.state("approvals")),
        events: { append: appendEvent }, policy: { mode: "ask" },
    });
    return {
        directory, databasePath, instanceName, audit, events, history, tool, runtime, approval,
        async close() {
            approval.close(); runtime.close(); await scheduler.close(); await audit.close();
            await rm(directory, { recursive: true, force: true });
        },
    };
}
