import assert from "node:assert/strict";
import test from "node:test";

import { InstanceRegistry } from "../../../../src/instance/Registry.ts";
import { InstanceCreateCoordinator } from "../../../../src/instance/editor/create/index.ts";
import { InstanceChangeHub } from "../../../../src/instance/Change.ts";
import { ConfigChangeHub } from "../../../../src/config/change/Config.ts";
import { ConfigEngine } from "../../../../src/config/engine/index.ts";
import {
    createDefaultControlConfig,
    normalizeConfigInstanceDraft,
    type ControlConfig,
} from "@portable-devshell/shared";
import { createTestInstance, testRuntimeHooks } from "../../../support/InstanceRuntime.ts";

test("instance create validates docker preset drafts into container config", () => {
    const service = createService("linux");

    const summary = service.validateDraft({
        container: {
            mode: "preset",
            preset: "arch",
        },
        name: "demo-docker",
        provider: "docker",
    });

    assert.deepEqual(summary.container, {
        containerName: "devshell-demo-docker",
        env: undefined,
        image: "archlinux:latest",
        mode: "preset",
        mounts: undefined,
        network: undefined,
        preset: "arch",
        user: undefined,
    });
    assert.equal(summary.provider, "docker");
});

test("instance create defaults MCP authentication to oauth2", () => {
    const service = createService("linux");

    const summary = service.validateDraft({
        name: "demo-local",
        provider: "local",
    });

    assert.deepEqual(summary.mcp.auth, {
        mode: "oauth2",
        oauth2: {
            documentationUrl: undefined,
            requiredScopes: ["mcp"],
            resourceName: "demo-local",
        },
    });
});

test("instance create validates existing stopped container drafts with adoptLifecycle", () => {
    const service = createService("linux");

    const summary = service.validateDraft({
        container: {
            adoptLifecycle: true,
            containerName: "my-stopped-container",
            mode: "existingStoppedContainer",
        },
        name: "demo-podman",
        provider: "podman",
    });

    assert.deepEqual(summary.container, {
        adoptLifecycle: true,
        containerName: "my-stopped-container",
        mode: "existingStoppedContainer",
    });
});

test("instance create validation summary never returns secret values", () => {
    const service = createService("linux");

    const summary = service.validateDraft({
        container: {
            containerName: "devshell-demo-docker",
            env: { CONTAINER_TOKEN: "container-secret" },
            image: "archlinux:latest",
            mode: "existingImage",
        },
        env: { API_TOKEN: "instance-secret" },
        mcp: {
            auth: "token",
            contextMode: "explicit",
            enabled: true,
            token: "mcp-secret-" + "x".repeat(32),
        },
        name: "demo-docker",
        provider: "docker",
    });

    const serialized = JSON.stringify(summary);
    assert.equal(serialized.includes("instance-secret"), false);
    assert.equal(serialized.includes("container-secret"), false);
    assert.equal(serialized.includes("mcp-secret-"), false);
    assert.deepEqual(summary.env, { API_TOKEN: "********" });
    assert.deepEqual(
        summary.container?.mode === "existingImage"
            ? summary.container.env
            : undefined,
        { CONTAINER_TOKEN: "********" },
    );
});

test("disabled instance creation publishes the committed instance config", async () => {
    let config = createDefaultControlConfig();
    const configChanges = new ConfigChangeHub();
    const instanceChanges = new InstanceChangeHub();
    configChanges.onChange((change) => {
        if (
            change.paths.some(
                (path) => path === "instances" || path.startsWith("instances."),
            )
        ) {
            instanceChanges.publish("config");
        }
    });
    const engine = createEngine(
        () => config,
        (nextConfig) => {
            config = nextConfig;
        },
        async () => {},
        configChanges,
    );
    const service = new InstanceCreateCoordinator({
        ...testRuntimeHooks(),
        engine,
        instanceChanges,
        instanceRegistry: new InstanceRegistry([]),
    });

    const result = await service.createInstance({
        enabled: false,
        name: "demo-disabled",
        provider: "local",
    });

    assert.equal(result.enabled, false);
    assert.deepEqual(config.instances.map(({ name }) => name), ["demo-disabled"]);
    assert.equal(configChanges.revision, 1);
    assert.equal(instanceChanges.revision, 1);
    assert.deepEqual(instanceChanges.replay(1), {
        changes: [{ kind: "config", revision: 1 }],
        kind: "replay",
        lastRevision: 1,
    });
});

function createService(platform?: NodeJS.Platform) {
    let config = createDefaultControlConfig();
    const engine = createEngine(
        () => config,
        (nextConfig) => {
            config = nextConfig;
        },
    );

    return new InstanceCreateCoordinator({
        ...testRuntimeHooks(),
        engine,
        instanceChanges: new InstanceChangeHub(),
        instanceRegistry: new InstanceRegistry([]),
        platform,
    });
}

test("instance create prepares the runtime descriptor before persisting configuration", async () => {
    let config = createDefaultControlConfig();
    let writes = 0;
    const engine = createEngine(
        () => config,
        (nextConfig) => {
            config = nextConfig;
        },
        async () => {
            writes += 1;
        },
    );
    const service = new InstanceCreateCoordinator({
        ...testRuntimeHooks(),
        engine,
        createRuntimeInstance() {
            throw new Error("runtime descriptor failed");
        },
        instanceChanges: new InstanceChangeHub(),
        instanceRegistry: new InstanceRegistry([]),
    });

    await assert.rejects(
        service.createInstance({
            name: "demo-local",
            provider: "local",
        }),
        /runtime descriptor failed/u,
    );
    assert.equal(writes, 0);
    assert.deepEqual(config.instances, []);
});

test("instance create restores configuration and registry when MCP registration fails", async () => {
    let config = createDefaultControlConfig();
    config.mcp.enabled = true;
    const writes: ControlConfig[] = [];
    const registry = new InstanceRegistry([]);
    const configChanges = new ConfigChangeHub();
    const descriptor = createTestInstance(
        normalizeConfigInstanceDraft({
            mcp: { enabled: true },
            name: "demo-local",
            provider: "local",
        }),
    );
    let finalized = 0;
    const engine = createEngine(
        () => config,
        (nextConfig) => {
            config = nextConfig;
        },
        async (nextConfig) => {
            writes.push(structuredClone(nextConfig));
        },
        configChanges,
    );
    const service = new InstanceCreateCoordinator({
        ...testRuntimeHooks(),
        engine,
        createRuntimeInstance: () => descriptor,
        finalizeRuntimeInstance: async () => {
            finalized += 1;
        },
        instanceChanges: new InstanceChangeHub(),
        instanceRegistry: registry,
        mcp: {
            registerInstance() {
                throw new Error("MCP registration failed");
            },
            async retireMcpApp() {},
            unregisterInstance() {},
        },
    });

    await assert.rejects(
        service.createInstance({
            mcp: { enabled: true },
            name: "demo-local",
            provider: "local",
        }),
        /MCP registration failed/u,
    );
    assert.equal(writes.length, 2);
    assert.deepEqual(config.instances, []);
    assert.equal(registry.get("demo-local"), undefined);
    assert.equal(descriptor.lifecycle.retired, true);
    assert.equal(finalized, 1);
    assert.equal(configChanges.revision, 0);
});

test("instance create defaults to SSH after a local instance already exists", () => {
    let config = createDefaultControlConfig();
    config = {
        ...config,
        instances: [
            normalizeConfigInstanceDraft({
                name: "local",
                provider: "local",
            }),
        ],
    };
    const engine = createEngine(
        () => config,
        (nextConfig) => {
            config = nextConfig;
        },
    );
    const service = new InstanceCreateCoordinator({
        ...testRuntimeHooks(),
        engine,
        instanceChanges: new InstanceChangeHub(),
        instanceRegistry: new InstanceRegistry([]),
        sshHosts: () => ["aromatic-server", "build-server"],
    });

    const schema = service.getSchema();
    assert.equal(schema.defaultProvider, "ssh");
    assert.deepEqual(schema.sshHosts, ["aromatic-server", "build-server"]);
});

function createEngine(
    getConfig: () => ControlConfig,
    setConfig: (config: ControlConfig) => void,
    write: (config: ControlConfig) => Promise<void> = async () => {},
    changeHub?: ConfigChangeHub,
): ConfigEngine {
    return new ConfigEngine({
        ...(changeHub === undefined ? {} : { changeHub }),
        configStore: { write },
        getConfig,
        setConfig,
    });
}
