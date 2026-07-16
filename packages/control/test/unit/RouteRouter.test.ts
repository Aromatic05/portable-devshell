import assert from "node:assert/strict";
import test from "node:test";

import type { WorkerInstance } from "@portable-devshell/core/testing";
import type { JsonValue, PrefixRouteContext } from "@portable-devshell/shared";

import type { ArtifactService } from "../../dist/control/artifact/ArtifactService.js";
import { InstanceRegistry } from "../../dist/control/instance/registry/InstanceRegistry.js";
import { ControlRouteComposition } from "../../dist/composition/ControlRouteComposition.js";

test("ControlRouteComposition exposes the consolidated control modules", () => {
    const snapshot = createSnapshot(new InstanceRegistry([]));
    const control = snapshot.destinations.get("@control");

    assert.deepEqual([...control!.keys()], [
        "service",
        "mcp",
        "instance",
        "config",
        "reverse",
        "artifact"
    ]);
    assert.deepEqual([...control!.get("service")!.keys()], ["ping", "status", "shutdown", "restart"]);
    assert.deepEqual([...control!.get("instance")!.keys()], [
        "list",
        "createSchema",
        "validateCreate",
        "create",
        "enable",
        "disable",
        "delete"
    ]);
});

test("ControlRouteComposition creates one consolidated destination tree per instance", () => {
    const registry = new InstanceRegistry([
        {
            enabled: true,
            mcpEnabled: false,
            mcpPath: "",
            name: "alpha",
            todo: {
                async read() {
                    return { items: [], revision: 0, summary: { completed: 0, total: 0 } };
                },
                summary() {
                    return undefined;
                }
            },
            worker: {
                snapshot() {
                    return {
                        connectionState: "disconnected",
                        daemonState: "stopped",
                        lastSeq: 0,
                        name: "alpha",
                        ready: false,
                        status: "stopped"
                    };
                }
            } as unknown as WorkerInstance
        }
    ]);
    const snapshot = createSnapshot(registry);
    const instance = snapshot.destinations.get("alpha" as never);

    assert.deepEqual([...instance!.keys()], ["runtime", "todo", "tool"]);
    assert.deepEqual([...instance!.get("runtime")!.keys()], [
        "snapshot",
        "refresh",
        "start",
        "stop",
        "readLogs",
        "subscribe"
    ]);
    assert.deepEqual([...instance!.get("tool")!.keys()], [
        "call",
        "listCalls",
        "listApprovals",
        "getApproval",
        "decideApproval"
    ]);
    assert.deepEqual([...instance!.get("todo")!.keys()], ["get", "subscribe"]);
});

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
                    updatedAt: "2026-07-13T00:00:00.000Z"
                }
            };
        }
    } as unknown as ArtifactService;
    const table = new ControlRouteComposition({
        artifact: artifactService,
        instances: new InstanceRegistry([]),
        shutdown() {}
    });
    const snapshot = table.snapshot();
    const handler = snapshot.destinations.get("@control")!.get("artifact")!.get("startTransfer")!;

    const result = await handler(
        {
            id: "artifact-start",
            name: "startTransfer",
            payload: {
                instance: "source-a",
                sourcePath: "./result.bin",
                targetInstance: "target-b",
                targetPath: "/tmp/result.bin"
            }
        },
        createContext("@control", "artifact")
    );

    assert.equal((result as { transfer: { status: string } }).transfer.status, "queued");
    assert.deepEqual(calls, [
        {
            defaultInstance: "source-a",
            input: {
                instance: "source-a",
                operation: "start",
                sourcePath: "./result.bin",
                targetInstance: "target-b",
                targetPath: "/tmp/result.bin"
            }
        }
    ]);
});

function createSnapshot(instanceRegistry: InstanceRegistry) {
    return new ControlRouteComposition({
        instances: instanceRegistry,
        shutdown() {}
    }).snapshot();
}

function createContext(destination: "@control" | string, module: string): PrefixRouteContext {
    return {
        afterReply() {},
        connectionId: "connection-1",
        destination: destination as never,
        module,
        async openStream() {
            throw new Error("stream not expected");
        },
        peer: "cli",
        requestId: "request-1",
        signal: new AbortController().signal
    };
}

void (0 as unknown as JsonValue);
