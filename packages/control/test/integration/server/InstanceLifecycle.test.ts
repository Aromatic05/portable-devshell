import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { Endpoint, LocalChannel, createInstanceTransport, createServerTransport } from "@portable-devshell/shared";
import { Control } from "../../../src/Control.ts";
import { ControlFactory } from "../../../src/Factory.ts";
import { ControlConfigStore } from "../../../src/config/store/index.ts";
import { resolveTestWorkerBinary, workerPathEnvironmentName } from "../../../../../test/TestPlatformSupport.ts";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";

test("current Control composition creates, updates and retires instances over RPC and persists restart state", async (t) => {
    const worker = resolveTestWorkerBinary();
    assert.ok(worker, "Control lifecycle integration requires a prepared Worker binary");
    const workerEnv = workerPathEnvironmentName();
    const previousWorker = process.env[workerEnv];
    process.env[workerEnv] = worker;
    const root = await createTestTempDirectory("control-instance-lifecycle");
    const store = new ControlConfigStore();
    const server = new Control({
        configStore: store,
        homeDirectory: root,
        factory: new ControlFactory({ builtinExtensionSources: [] }),
        xdgRuntimeDir: root,
    });
    const endpoint = new Endpoint({ connectChannel: signal => LocalChannel.connect(server.socketPath, { signal }) });
    t.after(async () => {
        endpoint.close();
        try {
            await server.stop();
        } finally {
            if (previousWorker === undefined) delete process.env[workerEnv];
            else process.env[workerEnv] = previousWorker;
            await rm(root, { force: true, recursive: true });
        }
    });
    await server.start();
    await createServerTransport(endpoint, { clientKind: "cli" }).hello();
    const instances = createInstanceTransport(endpoint);
    assert.deepEqual(await instances.listInstances(), []);

    await instances.createInstance({ name: "test-local", provider: "local", mcp: { enabled: false } });
    assert.equal(server.config!.instances[0]!.name, "test-local");
    assert.equal((await instances.listInstances())[0]!.enabled, true);
    await instances.updateInstance({ instanceName: "test-local", patch: { env: { LIFECYCLE_TEST: "updated" } } });
    assert.deepEqual(server.config!.instances[0]!.env, { LIFECYCLE_TEST: "updated" });
    await instances.disableInstance("test-local");
    assert.equal((await instances.listInstances())[0]!.enabled, false);
    await instances.enableInstance("test-local");
    assert.equal((await instances.listInstances())[0]!.enabled, true);

    endpoint.close();
    await server.stop();
    await server.start();
    assert.deepEqual(server.config!.instances[0]!.env, { LIFECYCLE_TEST: "updated" });
    const reconnected = new Endpoint({ connectChannel: signal => LocalChannel.connect(server.socketPath, { signal }) });
    t.after(() => reconnected.close());
    await createServerTransport(reconnected, { clientKind: "cli" }).hello();
    const afterRestart = createInstanceTransport(reconnected);
    await afterRestart.deleteInstance("test-local");
    const beforeDisabledCreate = await afterRestart.snapshotInstances();
    await afterRestart.createInstance({ name: "disabled-local", provider: "local", enabled: false });
    const disabledSnapshot = await afterRestart.snapshotInstances();
    assert.equal(disabledSnapshot.revision, beforeDisabledCreate.revision + 1);
    assert.equal(disabledSnapshot.instances[0]!.enabled, false);
    await afterRestart.deleteInstance("disabled-local");
    assert.deepEqual(server.config!.instances, []);
    assert.deepEqual((await store.readOrCreate(root)).instances, []);
});
