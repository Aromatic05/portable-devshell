import assert from "node:assert/strict";
import test from "node:test";
import { EXTENSION_API_VERSION, EXTENSION_MANIFEST_SCHEMA_VERSION, type ExtensionManifest } from "@portable-devshell/extension";
import type { ControlRouteDeclaration } from "@portable-devshell/extension/control";
import type { ControlPortContext, MessageStream } from "@portable-devshell/shared";
import { ControlExtensionRouteService } from "../../../src/extension/api/point/control/Dispatch.ts";
import { ExtensionHost } from "../../../src/extension/host/index.ts";
import { ExtensionGeneration } from "../../../src/extension/registration/Generation.ts";
import { ExtensionRegistrationSet } from "../../../src/extension/registration/Registration.ts";
import { createControlExtensionPointRegistry } from "../../../src/extension/registration/Points.ts";
import { deferred } from "./Round3Harness.ts";

const original: ControlRouteDeclaration = { id: "same-id", scope: "instance", module: "messages", operation: "read" };
const context = { host: "instance-a", peer: "web", requestId: "request", signal: new AbortController().signal } as ControlPortContext;

for (const pointId of ["control.routes", "control.streams"]) {
    for (const change of [
        { scope: "control" as const },
        { module: "settings" },
        { operation: "write" },
        {},
    ]) {
        test(`${pointId} retained entry fences delayed replacement ${JSON.stringify(change)}`, async (t) => {
            const loading = deferred();
            const resume = deferred();
            const calls: string[] = [];
            const runtimes: ExtensionGeneration[] = [];
            let closes = 0;
            const failures: unknown[] = [];
            const declaration = (generation: string) => generation === "g1" ? original : { ...original, ...change };
            const manifest = (generation: string): ExtensionManifest => ({
                activation: "lazy", apiVersion: EXTENSION_API_VERSION, schemaVersion: EXTENSION_MANIFEST_SCHEMA_VERSION,
                capabilities: [], entry: "extension.mjs", hostDependencies: {}, id: "example", name: "Example", version: "1.0.0",
                extensions: { [pointId]: [declaration(generation)] },
            });
            let snapshot = { schemaVersion: 1, extensions: { example: { enabled: true, selectedGeneration: "g1" } } };
            const host = new ExtensionHost({
                registry: { read: async () => structuredClone(snapshot), write: async (next) => { snapshot = structuredClone(next) as typeof snapshot; } },
                loader: {
                    points: createControlExtensionPointRegistry(), readManifest: async (_id, generation) => manifest(generation),
                    load: async (_id, generation) => {
                        loading.resolve();
                        await resume.promise;
                        const runtime = new ExtensionGeneration({ generation, manifest: manifest(generation), dispose: async () => {},
                            registrations: new ExtensionRegistrationSet([{ pointId, id: original.id, declaration: declaration(generation),
                                binding: async () => { calls.push(generation); return generation; } }]) });
                        runtimes.push(runtime);
                        return runtime;
                    },
                },
            });
            await host.start();
            const service = new ControlExtensionRouteService(host);
            t.after(async () => { resume.resolve(); await service.retireInstance(context.host); await host.stop(); });
            const port = service.modules("instance")[0]!;
            const upgrading = host.activateGeneration("example", "g2");
            await loading.promise;
            const stream = { send: async () => {}, close: async () => { closes++; }, cancel: async (error: unknown) => { failures.push(error); } } as unknown as MessageStream;
            const pending = Promise.resolve(pointId === "control.routes"
                ? port.operations[0]!.handle({ id: "wire", name: "read" }, context)
                : port.streams![0]!.handle(stream, { id: "wire", name: "read" }, context));
            const observed = pending.then((value) => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));
            resume.resolve();
            await upgrading;
            const result = await observed;
            await service.retireInstance(context.host);
            const same = Object.keys(change).length === 0;
            assert.deepEqual(calls, same ? ["g2"] : []);
            assert.equal(runtimes[0]!.inFlight, 0);
            assert.equal(String(result.error), pointId === "control.routes" && !same
                ? "Error: Control route same-id declaration changed." : "undefined");
            assert.equal(result.value, pointId === "control.routes" && same ? "g2" : undefined);
            assert.deepEqual(failures.map((error) => (error as { message: string }).message),
                pointId === "control.streams" && !same ? ["Control route same-id declaration changed."] : []);
            assert.equal(closes, pointId === "control.streams" && same ? 1 : 0);
        });
    }
}

test("Host rejects a distinct route ID conflict before registry commit and change publication", async (t) => {
    let writes = 0;
    let changes = 0;
    let disposed = 0;
    const manifest = (id: string): ExtensionManifest => ({
        activation: "lazy", apiVersion: EXTENSION_API_VERSION, schemaVersion: EXTENSION_MANIFEST_SCHEMA_VERSION,
        capabilities: [], entry: "extension.mjs", hostDependencies: {}, id, name: id, version: "1.0.0",
        extensions: { "control.routes": [{ ...original, id }] },
    });
    const host = new ExtensionHost({
        registry: { read: async () => ({ schemaVersion: 1, extensions: { first: { enabled: true, selectedGeneration: "g1" }, second: { enabled: false, selectedGeneration: "g1" } } }),
            write: async () => { writes++; } },
        loader: {
            points: createControlExtensionPointRegistry(), readManifest: async (id) => manifest(id),
            load: async (id, generation) => new ExtensionGeneration({ generation, manifest: manifest(id), dispose: async () => { disposed++; },
                registrations: new ExtensionRegistrationSet([{ pointId: "control.routes", id, declaration: { ...original, id }, binding: async () => id }]) }),
        },
    });
    await host.start();
    t.after(async () => await host.stop());
    host.onChange(() => { changes++; });
    const service = new ControlExtensionRouteService(host);
    const before = host.listDeclarations("control.routes");
    await assert.rejects(host.activateGeneration("second", "g2"), /registered more than once/);
    assert.equal(writes, 0);
    assert.equal(changes, 0);
    assert.equal(disposed, 0, "static preflight rejects before loading the candidate");
    assert.deepEqual(host.listDeclarations("control.routes"), before);
    assert.equal(service.modules("instance")[0]!.operations.length, 1);
});

for (const pointId of ["control.routes", "control.streams"]) {
    test(`${pointId} retained entry rejects reassignment to a different extension`, async (t) => {
        const calls: string[] = [];
        const failures: unknown[] = [];
        const manifest = (id: string): ExtensionManifest => ({
            activation: "lazy", apiVersion: EXTENSION_API_VERSION, schemaVersion: EXTENSION_MANIFEST_SCHEMA_VERSION,
            capabilities: [], entry: "extension.mjs", hostDependencies: {}, id, name: id, version: "1.0.0",
            extensions: { [pointId]: [original] },
        });
        const host = new ExtensionHost({
            registry: { read: async () => ({ schemaVersion: 1, extensions: {
                first: { enabled: true, selectedGeneration: "g1" }, second: { enabled: false, selectedGeneration: "g1" },
            } }), write: async () => {} },
            loader: {
                points: createControlExtensionPointRegistry(), readManifest: async (id) => manifest(id),
                load: async (id, generation) => new ExtensionGeneration({ generation, manifest: manifest(id), dispose: async () => {},
                    registrations: new ExtensionRegistrationSet([{ pointId, id: original.id, declaration: original,
                        binding: async () => { calls.push(id); } }]) }),
            },
        });
        await host.start();
        const service = new ControlExtensionRouteService(host);
        t.after(async () => { await service.retireInstance(context.host); await host.stop(); });
        const port = service.modules("instance")[0]!;
        await host.disable("first");
        await host.activateGeneration("second", "g1");
        const stream = { send: async () => {}, close: async () => {}, cancel: async (error: unknown) => { failures.push(error); } } as unknown as MessageStream;
        const invoke = async () => pointId === "control.routes"
            ? await port.operations[0]!.handle({ id: "wire", name: "read" }, context)
            : await port.streams![0]!.handle(stream, { id: "wire", name: "read" }, context);
        const result = await invoke().then(() => undefined, (error: unknown) => String(error));
        await service.retireInstance(context.host);
        assert.deepEqual(calls, []);
        assert.equal(result, pointId === "control.routes" ? "Error: Control route same-id declaration changed." : undefined);
        assert.deepEqual(failures.map((error) => (error as { message: string }).message),
            pointId === "control.streams" ? ["Control route same-id declaration changed."] : []);
    });
}
