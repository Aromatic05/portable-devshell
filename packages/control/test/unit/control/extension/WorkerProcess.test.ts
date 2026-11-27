import assert from "node:assert/strict";
import test from "node:test";
import type { ControlStreamBinding } from "@portable-devshell/extension/control";
import type { ExtensionPointSandboxBridge } from "../../../../src/extension/registration/PointRegistry.ts";
import { ExtensionWorkerProcessControl } from "../../../../src/extension/api/cap/worker/Process.ts";
import { ExtensionSandboxWorkerProcessBridge } from "../../../../src/extension/sandbox/bridge/WorkerProcesses.ts";
import { controlStreamsExtensionPointDefinition, controlStreamsSandboxCodec } from "../../../../src/extension/api/point/control/Stream.ts";

test("owned worker process resolves resource paths, transfers bytes and releases its instance lease", async () => {
    let leases = 0;
    let cancelled = false;
    let retirement: (() => void) | undefined;
    const listeners = new Set<() => void>();
    const data = Uint8Array.of(0, 255, 128, 10);
    let written: Uint8Array | undefined;
    let opened: unknown;
    let ended = false;
    const stream = {
        read: async () => data,
        write: async (bytes: Uint8Array) => { written = bytes; },
        finish: async () => { ended = true; },
        onClose() {},
        onCancel(listener: () => void) { listeners.add(listener); },
        cancel: async () => {
            cancelled = true;
            for (const listener of listeners) listener();
        },
    };
    const instance = {
        lifecycle: {
            active: true,
            acquireLease() {
                leases++;
                return { release: () => { leases--; } };
            },
            onRetiring(listener: () => void) { retirement = listener; return () => { retirement = undefined; }; },
        },
        supervision: { snapshot: () => ({ ready: true }), handshake: { platform: { os: "linux" } } },
        environment: {
            prepareExtensionResource: async ({ extensionId, collection }: { extensionId: string; collection: string }) => {
                assert.equal(extensionId, "browser");
                return { directory: "/worker/extensions/browser/" + collection };
            },
        },
        openWorkerProcess: async (input: unknown, signal: AbortSignal) => {
            opened = input;
            signal.addEventListener("abort", () => void stream.cancel(), { once: true });
            return stream;
        },
    };
    const registry = { get: () => instance } as unknown as ConstructorParameters<typeof ExtensionWorkerProcessControl>[0]["instances"];
    const capability = new ExtensionWorkerProcessControl({ allowed: true, extensionId: "browser", instances: registry });
    const bridge = new ExtensionSandboxWorkerProcessBridge(capability);
    const id = await bridge.start({
        instance: "dev",
        executable: { collection: "runtime", key: "bundle", path: "bin/node" },
        args: [{ collection: "runtime", key: "bundle", path: "helper.mjs" }, { collection: "profiles", key: "work" }],
    }, new AbortController().signal);
    assert.deepEqual(opened, {
        executable: "/worker/extensions/browser/runtime/bundle/bin/node",
        args: ["/worker/extensions/browser/runtime/bundle/helper.mjs", "/worker/extensions/browser/profiles/work"],
        cwd: undefined,
        owned: true,
    });
    assert.equal(leases, 1);
    assert.equal(await bridge.read(id), Buffer.from(data).toString("base64"));
    await bridge.write(id, Buffer.from(data).toString("base64"));
    assert.deepEqual(new Uint8Array(written!), data);
    await bridge.finish(id);
    assert.equal(ended, true);
    retirement!();
    await capability.closeAll();
    assert.equal(cancelled, true);
    assert.equal(leases, 0);
    await bridge.close(id);
});

test("control stream sandbox preserves binary frame bytes", async () => {
    const validation = { codeDirectory: "/browser", extensionId: "browser", id: "browser-frames" };
    const frame = Uint8Array.of(255, 216, 0, 128, 255, 217);
    const binding: ControlStreamBinding = async stream => { await stream.write(frame); };
    const bridge: ExtensionPointSandboxBridge = {
        async invokeBinding(_pointId, _id, input, options) {
            return controlStreamsSandboxCodec.invokeBinding(binding, input, options!.signal!, {
                ...validation,
                requestInterface: (operation, value) => options!.interfacePort!.request(operation, value),
            });
        },
    };
    const proxy = controlStreamsExtensionPointDefinition.createSandboxBinding!(
        controlStreamsSandboxCodec.describeBinding(binding, validation), validation, bridge,
    ) as ControlStreamBinding;
    const received: Uint8Array[] = [];
    await proxy({
        send: async () => { throw new Error("Expected a binary frame."); },
        write: async bytes => { received.push(new Uint8Array(bytes)); },
        close: async () => {},
    }, {}, { destination: "@control", peer: "web", requestId: "frame", signal: new AbortController().signal });
    assert.deepEqual(received, [frame]);
});
