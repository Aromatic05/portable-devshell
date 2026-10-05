import assert from "node:assert/strict";
import test from "node:test";

import type { ControlPortContext } from "@portable-devshell/shared";

import type { ArtifactService } from "../../../src/artifact/Service.ts";
import { InstanceRegistry } from "@portable-devshell/core";
import { ControlRouteRegistry } from "../../../src/server/Route.ts";
import { createTestInstanceDomainRuntime } from "../../../src/testing.ts";

test("artifact.startTransfer accepts an explicit source instance", async () => {
    const calls: unknown[] = [];
    const artifactService = {
        async startTransfer(input: unknown, defaultInstance: string) {
            calls.push({ defaultInstance, input });
            return {
                operation: "start",
                transfer: {
                    createdAt: "2026-07-13T00:00:00.000Z",
                    source: { instance: defaultInstance, path: "./result.bin" },
                    status: "queued",
                    target: { instance: "target-b", path: "/tmp/result.bin" },
                    transferId: "transfer-1",
                    transferredBytes: 0,
                    updatedAt: "2026-07-13T00:00:00.000Z",
                },
            };
        },
    } as unknown as ArtifactService;
    const routes = new ControlRouteRegistry({
        artifact: artifactService,
        instanceDomains: createTestInstanceDomainRuntime(),
        instances: new InstanceRegistry([]),
        shutdown() {},
    });
    const control = routes.hosts().find((host) => host.host === "@control")!;
    const artifact = control.ports.find((port) => port.name === "artifact")!;
    const handler = artifact.operations.find(
        (operation) => operation.name === "startTransfer",
    )!.handle;

    const result = await handler(
        {
            id: "artifact-start",
            name: "startTransfer",
            payload: {
                instance: "source-a",
                sourcePath: "./result.bin",
                sourceWorkspace: "/source",
                targetInstance: "target-b",
                targetPath: "/tmp/result.bin",
                targetWorkspace: "/tmp",
            },
        },
        createContext("@control"),
    );

    assert.equal(
        (result as { transfer: { status: string } }).transfer.status,
        "queued",
    );
    assert.deepEqual(calls, [
        {
            defaultInstance: "source-a",
            input: {
                instance: "source-a",
                operation: "start",
                sourcePath: "./result.bin",
                sourceWorkspace: "/source",
                targetInstance: "target-b",
                targetPath: "/tmp/result.bin",
                targetWorkspace: "/tmp",
            },
        },
    ]);
});

function createContext(host: string): ControlPortContext {
    return {
        afterReply() {},
        connectionId: "connection-1",
        host,
        peer: "cli",
        requestId: "request-1",
        signal: new AbortController().signal,
    };
}

test("native control tool.call admits a nonexistent original instance to host ingress", async () => {
    const calls: string[] = [];
    const routes = new ControlRouteRegistry({
        instanceDomains: createTestInstanceDomainRuntime(),
        instances: new InstanceRegistry([]),
        shutdown() {},
        toolCalls: {
            async call(instance, toolName, input, context) {
                calls.push(instance);
                assert.equal(toolName, "file_read");
                assert.deepEqual(input, { path: "file.txt" });
                assert.equal(context.workspace, "/workspace");
                return { content: "read" };
            },
        },
    });
    const dynamic = routes.hosts().find((host) => host.host === "*")!;
    const tool = dynamic.ports.filter((port) => port.name === "tool");
    assert.equal(tool.length, 1);
    assert.deepEqual(
        tool[0]!.operations.map((entry) => entry.name),
        ["call"],
    );
    assert.deepEqual(
        tool[0]!.streams!.map((entry) => entry.name),
        ["callStream"],
    );
    assert.deepEqual(
        await tool[0]!.operations[0]!.handle(
            {
                id: "call-unknown",
                name: "call",
                payload: {
                    toolName: "file_read",
                    input: { path: "file.txt" },
                    workspace: "/workspace",
                },
            },
            createContext("nonexistent"),
        ),
        { content: "read" },
    );
    assert.deepEqual(calls, ["nonexistent"]);
    routes.dispose();
});
