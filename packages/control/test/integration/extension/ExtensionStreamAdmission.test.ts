import assert from "node:assert/strict";
import test from "node:test";
import { EXTENSION_API_VERSION, EXTENSION_MANIFEST_SCHEMA_VERSION, type ExtensionManifest } from "@portable-devshell/extension";
import type { ControlStreamBinding } from "@portable-devshell/extension/control";
import type { ControlPortContext, MessageStream } from "@portable-devshell/shared";
import { ControlExtensionRouteService } from "../../../src/extension/api/point/control/Dispatch.ts";
import { ExtensionHost } from "../../../src/extension/host/index.ts";
import { ExtensionGeneration } from "../../../src/extension/registration/Generation.ts";
import { ExtensionRegistrationSet } from "../../../src/extension/registration/Registration.ts";
import { createControlExtensionPointRegistry } from "../../../src/extension/registration/Points.ts";
import { deferred } from "./Round3Harness.ts";

test("BUG: Instance retirement must include streams awaiting real lazy Host activation", async () => {
    const loading = deferred();
    const resume = deferred();
    const declaration = { id: "watch", module: "events", operation: "watch", scope: "instance" } as const;
    const manifest: ExtensionManifest = {
        activation: "lazy", apiVersion: EXTENSION_API_VERSION,
        schemaVersion: EXTENSION_MANIFEST_SCHEMA_VERSION, capabilities: [],
        entry: "extension.mjs", hostDependencies: {}, id: "matrix", name: "Matrix", version: "1.0.0",
        extensions: { "control.streams": [declaration] },
    };
    let invocations = 0;
    let signal: AbortSignal | undefined;
    let closes = 0;
    let runtime!: ExtensionGeneration;
    const binding: ControlStreamBinding = async (_stream, _request, context) => {
        invocations++;
        signal = context.signal;
        await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
    };
    const host = new ExtensionHost({
        registry: { read: async () => ({ schemaVersion: 1, extensions: { matrix: { enabled: true, selectedGeneration: "hash" } } }),
            write: async () => {} },
        loader: {
            points: createControlExtensionPointRegistry(), readManifest: async () => manifest,
            load: async () => {
                loading.resolve();
                await resume.promise;
                runtime = new ExtensionGeneration({ generation: "hash", manifest, dispose: async () => {},
                    registrations: new ExtensionRegistrationSet([{ declaration, binding, id: "watch", pointId: "control.streams" }]) });
                return runtime;
            },
        },
    });
    await host.start();
    const service = new ControlExtensionRouteService(host);
    try {
        const handle = service.modules("instance")[0]!.streams![0]!.handle;
        const admission = handle({ send: async () => {}, close: async () => { closes++; },
            cancel: async () => { assert.fail("unexpected transport failure"); } } as unknown as MessageStream,
        { id: "pending", name: "watch" }, { host: "instance-a", peer: "web", requestId: "pending",
            signal: new AbortController().signal } as ControlPortContext);
        await loading.promise;
        await service.retireInstance("instance-a");
        resume.resolve();
        await admission;
        const observed = { invocations, aborted: signal?.aborted, inFlight: runtime.inFlight, closes };
        console.log("after retirement and actual lazy Host activation", observed);
        await service.retireInstance("instance-a");
        assert.equal(observed.invocations, 0, "a pre-retirement pending admission escaped the retirement barrier");
    } finally { resume.resolve(); await service.retireInstance("instance-a"); await host.stop(); }
});
