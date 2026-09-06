import assert from "node:assert/strict";
import test from "node:test";

import type { WorkerInstance } from "@portable-devshell/core";
import type { ToolCallContext } from "@portable-devshell/shared";

import { DebugPatchService } from "../../src/control/debug/DebugPatchService.ts";
import { InstanceRegistry } from "../../src/control/instance/registry/InstanceRegistry.ts";

function context(ctxId: string): ToolCallContext {
    return {
        ctxId,
        requestId: `request-${ctxId}`,
        source: "mcp",
        workspace: "/workspace",
    };
}

test("DebugPatchService can hold one Context without intercepting the same tool in another Context", async () => {
    const calls: string[] = [];
    const worker = {
        async callTool(
            toolName: string,
            _input: unknown,
            callContext: ToolCallContext,
            signal?: AbortSignal,
        ) {
            if (signal?.aborted === true) throw signal.reason;
            calls.push(`${callContext.ctxId}:${toolName}`);
            return { ctxId: callContext.ctxId, toolName };
        },
    } as unknown as WorkerInstance;
    const registry = new InstanceRegistry([
        {
            name: "demo-local",
            worker,
        } as never,
    ]);
    const service = new DebugPatchService(registry);
    const patch = await service.load({
        source: `(event) =>
            event.args.context.ctxId === "ctx-own" && event.args.toolName === "file_info"
                ? { action: "hold", label: "own-context-probe" }
                : { action: "continue" }`,
        target: "worker:demo-local",
    });
    const controller = new AbortController();

    const ownCall = worker.callTool(
        "file_info",
        { paths: ["./probe"] },
        context("ctx-own"),
        controller.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(
        await worker.callTool(
            "file_info",
            { paths: ["./other"] },
            context("ctx-other"),
        ),
        { ctxId: "ctx-other", toolName: "file_info" },
    );
    assert.deepEqual(calls, ["ctx-other:file_info"]);

    controller.abort(new Error("host cancelled own Context"));
    await assert.rejects(ownCall, /host cancelled own Context/iu);
    assert.deepEqual(calls, ["ctx-other:file_info"]);

    const record = service.listPatches().find((entry) => entry.patchId === patch.patchId);
    assert.equal(record?.lastInvocation?.outcome, "aborted");
    assert.equal(record?.lastInvocation?.label, "own-context-probe");

    await service.unload(patch.patchId);
    await service.dispose();
});
