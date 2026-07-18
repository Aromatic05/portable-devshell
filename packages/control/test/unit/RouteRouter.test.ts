import assert from "node:assert/strict";
import test from "node:test";

import type { PrefixRouteContext } from "@portable-devshell/shared";

import type { ArtifactService } from "../../src/control/artifact/ArtifactService.ts";
import { InstanceRegistry } from "../../src/control/instance/registry/InstanceRegistry.ts";
import { ControlRouteComposition } from "../../src/composition/ControlRouteComposition.ts";



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
