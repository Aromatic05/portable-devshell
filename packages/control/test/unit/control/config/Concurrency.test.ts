import assert from "node:assert/strict";
import test from "node:test";

import type { ControlConfig } from "@portable-devshell/shared";
import { ConfigEditorCoordinator } from "../../../../src/config/editor/index.ts";
import { ConfigEngine } from "../../../../src/config/engine/index.ts";
import { ControlConfigMutationLock } from "../../../../src/config/engine/Lock.ts";
import { InstanceCreateCoordinator } from "../../../../src/instance/editor/create/index.ts";
import { InstanceChangeHub } from "../../../../src/instance/Change.ts";
import { createDefaultControlConfig } from "@portable-devshell/shared";
import { buildTestInstanceRegistry, testRuntimeHooks } from "../../../support/InstanceRuntime.ts";

test("instance creation and endpoint updates share one configuration mutation boundary", async () => {
    let config = createDefaultControlConfig();
    const registry = buildTestInstanceRegistry(config);
    const mutations = new ControlConfigMutationLock();
    let writeCount = 0;
    let releaseFirstWrite!: () => void;
    const firstWriteReleased = new Promise<void>((resolve) => {
        releaseFirstWrite = resolve;
    });
    let firstWriteStarted!: () => void;
    const firstWriteObserved = new Promise<void>((resolve) => {
        firstWriteStarted = resolve;
    });
    const configStore = {
        async write(next: ControlConfig) {
            writeCount += 1;
            if (writeCount === 1) {
                firstWriteStarted();
                await firstWriteReleased;
            }
            config = next;
        },
    };
    const getConfig = () => config;
    const setConfig = (next: ControlConfig) => {
        config = next;
    };
    const engine = new ConfigEngine({
        configStore,
        getConfig,
        mutationRunner: mutations,
        runtimePreflight: { async assertAvailable() {} },
        setConfig,
    });
    const editor = new ConfigEditorCoordinator({ engine });
    const creator = new InstanceCreateCoordinator({
        ...testRuntimeHooks(),
        engine,
        instanceChanges: new InstanceChangeHub(),
        instanceRegistry: registry,
    });

    const endpointUpdate = editor.updateWebConfig({
        patch: {
            enabled: true,
            listenHost: "127.0.0.1",
            listenPort: 17910,
            publicBaseUrl: "http://127.0.0.1:17910",
        },
    });
    await firstWriteObserved;
    const instanceCreate = creator.createInstance({
        name: "concurrent-local",
        provider: "local",
    });

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(writeCount, 1);
    releaseFirstWrite();
    await Promise.all([endpointUpdate, instanceCreate]);

    assert.equal(config.web.listenPort, 17910);
    assert.equal(config.web.enabled, true);
    assert.deepEqual(
        config.instances.map((instance) => instance.name),
        ["concurrent-local"],
    );
    assert.equal(writeCount, 2);
});
