import assert from "node:assert/strict";
import test from "node:test";

import { Instance, InstanceRegistry } from "@portable-devshell/core/instance";
import type { ToolCallContext } from "@portable-devshell/shared";

import { DebugPatchService } from "../../../../src/debug/Service.ts";

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
    const runtime = {
        async callTool(request: never) {
            const { value, signal } = request as unknown as {
                value: { context: ToolCallContext; toolName: string };
                signal?: AbortSignal;
            };
            if (signal?.aborted === true) throw signal.reason;
            calls.push(`${value.context.ctxId}:${value.toolName}`);
            return { ctxId: value.context.ctxId, toolName: value.toolName };
        },
    };
    const registry = new InstanceRegistry([
        new Instance({
            enabled: true,
            mcpEnabled: false,
            mcpPath: "",
            modelExtensions: [],
            name: "demo-local",
            provider: "local",
            worker: {} as never,
        }),
    ]);
    const service = new DebugPatchService(registry, () => runtime);
    const patch = await service.load({
        scope: { ctxId: "ctx-own", toolName: "file_read" },
        source: `(event) =>
            event.args.toolName === "file_read"
                ? { action: "hold", label: "own-context-probe" }
                : { action: "continue" }`,
        target: "worker:demo-local",
    });
    const controller = new AbortController();

    const invoke = async (toolName: string, payload: unknown, callContext: ToolCallContext, signal?: AbortSignal) =>
        await runtime.callTool({ value: { toolName, payload, context: callContext }, signal } as never);
    const ownCall = invoke("file_read", { files: [{ path: "./probe", view: "metadata" }] }, context("ctx-own"), controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(
        await invoke(
            "file_read",
            { files: [{ path: "./other", view: "metadata" }] },
            context("ctx-other"),
        ),
        { ctxId: "ctx-other", toolName: "file_read" },
    );
    assert.deepEqual(calls, ["ctx-other:file_read"]);
    assert.equal(service.listPatches()[0]?.invocationCount, 1);

    assert.deepEqual(
        await invoke("tmux_read", {}, context("ctx-own")),
        { ctxId: "ctx-own", toolName: "tmux_read" },
    );
    assert.deepEqual(calls, ["ctx-other:file_read", "ctx-own:tmux_read"]);
    assert.equal(service.listPatches()[0]?.invocationCount, 1);

    controller.abort(new Error("host cancelled own Context"));
    await assert.rejects(ownCall, /host cancelled own Context/iu);
    assert.deepEqual(calls, ["ctx-other:file_read", "ctx-own:tmux_read"]);

    const record = service
        .listPatches()
        .find((entry) => entry.patchId === patch.patchId);
    assert.equal(record?.lastInvocation?.outcome, "aborted");
    assert.equal(record?.lastInvocation?.label, "own-context-probe");

    await service.unload(patch.patchId);
    await service.dispose();
});

test("DebugPatchService rejects worker patches without an explicit Context scope", async () => {
    const runtime = {
        async callTool() {
            return {};
        },
    };
    const registry = new InstanceRegistry([
        new Instance({
            enabled: true,
            mcpEnabled: false,
            mcpPath: "",
            modelExtensions: [],
            name: "demo-local",
            provider: "local",
            worker: {} as never,
        }),
    ]);
    const service = new DebugPatchService(registry, () => runtime);

    await assert.rejects(
        service.load({
            source: `() => ({ action: "continue" })`,
            target: "worker:demo-local",
        }),
        /require a ctxId scope/iu,
    );

    await service.dispose();
});
