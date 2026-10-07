import assert from "node:assert/strict";
import test from "node:test";

import type { JsonValue } from "@portable-devshell/shared";

import { DebugPatchManager } from "../../../../src/debug/Patch.ts";

interface ToolCallRequest {
    signal?: AbortSignal;
    value: {
        context: { ctxId: string };
        payload?: JsonValue;
        toolName: string;
    };
}

class WorkerTarget {
    readonly calls: string[] = [];

    async callTool(request: ToolCallRequest): Promise<JsonValue> {
        if (request.signal?.aborted === true) throw request.signal.reason;
        this.calls.push(
            `${request.value.context.ctxId}:${request.value.toolName}`,
        );
        return {
            ctxId: request.value.context.ctxId,
            toolName: request.value.toolName,
        };
    }
}

function register(manager: DebugPatchManager, target: WorkerTarget): void {
    manager.registerTarget("worker:demo-local", target, {
        callTool: {
            project: (args) => {
                const request = args[0] as ToolCallRequest;
                return {
                    ctxId: request.value.context.ctxId,
                    payload: request.value.payload ?? null,
                    toolName: request.value.toolName,
                };
            },
            scope: (args) => {
                const request = args[0] as ToolCallRequest;
                return {
                    ctxId: request.value.context.ctxId,
                    toolName: request.value.toolName,
                };
            },
            signal: (args) => (args[0] as ToolCallRequest).signal,
        },
    });
}

test("DebugPatchManager holds one Context without intercepting the same tool in another Context", async () => {
    const manager = new DebugPatchManager();
    const target = new WorkerTarget();
    register(manager, target);
    const patch = await manager.load({
        scope: { ctxId: "ctx-own", toolName: "file_read" },
        source: `(event) =>
            event.args.toolName === "file_read"
                ? { action: "hold", label: "own-context-probe" }
                : { action: "continue" }`,
        target: "worker:demo-local",
    });
    const controller = new AbortController();

    const invoke = (
        toolName: string,
        callContext: { ctxId: string },
        signal?: AbortSignal,
    ) =>
        target.callTool({
            signal,
            value: { context: callContext, toolName },
        });
    const ownCall = invoke(
        "file_read",
        { ctxId: "ctx-own" },
        controller.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(
        await invoke("file_read", { ctxId: "ctx-other" }),
        { ctxId: "ctx-other", toolName: "file_read" },
    );
    assert.deepEqual(target.calls, ["ctx-other:file_read"]);
    assert.equal(manager.listPatches()[0]?.invocationCount, 1);

    assert.deepEqual(await invoke("tmux_read", { ctxId: "ctx-own" }), {
        ctxId: "ctx-own",
        toolName: "tmux_read",
    });
    assert.deepEqual(target.calls, [
        "ctx-other:file_read",
        "ctx-own:tmux_read",
    ]);
    assert.equal(manager.listPatches()[0]?.invocationCount, 1);

    controller.abort(new Error("host cancelled own Context"));
    await assert.rejects(ownCall, /host cancelled own Context/iu);
    assert.deepEqual(target.calls, [
        "ctx-other:file_read",
        "ctx-own:tmux_read",
    ]);

    const record = manager
        .listPatches()
        .find((entry) => entry.patchId === patch.patchId);
    assert.equal(record?.lastInvocation?.outcome, "aborted");
    assert.equal(record?.lastInvocation?.label, "own-context-probe");

    await manager.unload(patch.patchId);
    await manager.dispose();
});

test("DebugPatchManager rejects a scoped patch when the target cannot resolve Context scope", async () => {
    const manager = new DebugPatchManager();
    class PlainTarget {
        async callTool(request: ToolCallRequest): Promise<JsonValue> {
            return request.value.toolName;
        }
    }
    const target = new PlainTarget();
    manager.registerTarget("worker:demo-local", target, {
        callTool: {
            project: (args) =>
                (args[0] as ToolCallRequest).value.toolName,
        },
    });

    await assert.rejects(
        manager.load({
            scope: { ctxId: "ctx-own" },
            source: `() => ({ action: "continue" })`,
            target: "worker:demo-local",
        }),
        /does not support scoped patches/iu,
    );

    await manager.dispose();
});
