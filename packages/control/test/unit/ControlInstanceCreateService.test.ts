import assert from "node:assert/strict";
import test from "node:test";

import {
    InstanceRegistry,
    createDefaultControlConfig,
} from "../../src/testing.ts";
import { InstanceCreateCoordinator } from "../../src/control/instance/create/InstanceCreateCoordinator.ts";
import { normalizeConfigInstanceDraft, type ControlConfig } from "@portable-devshell/shared";

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
            mode: "existingImage"
        },
        env: { API_TOKEN: "instance-secret" },
        mcp: {
            auth: "token",
            enabled: true,
            token: "mcp-secret-" + "x".repeat(32)
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
        summary.container?.mode === "existingImage" ? summary.container.env : undefined,
        { CONTAINER_TOKEN: "********" }
    );
});

function createService(platform?: NodeJS.Platform) {
    let config = createDefaultControlConfig();

    return new InstanceCreateCoordinator({
        configStore: {
            async write(nextConfig) {
                config = nextConfig;
            },
        },
        getConfig: () => config,
        getMcpHost: () => undefined,
        instanceRegistry: new InstanceRegistry([]),
        platform,
        setConfig: (nextConfig) => {
            config = nextConfig;
        },
    });
}

test("instance create prepares the runtime descriptor before persisting configuration", async () => {
    let config = createDefaultControlConfig();
    let writes = 0;
    const service = new InstanceCreateCoordinator({
        configStore: {
            async write(nextConfig) {
                writes += 1;
                config = nextConfig;
            }
        },
        getConfig: () => config,
        getMcpHost: () => undefined,
        instanceConfigMapper: {
            map() {
                throw new Error("runtime descriptor failed");
            }
        } as never,
        instanceRegistry: new InstanceRegistry([]),
        setConfig: (nextConfig) => { config = nextConfig; }
    });

    await assert.rejects(
        service.createInstance({
            name: "demo-local",
            provider: "local",
        }),
        /runtime descriptor failed/u
    );
    assert.equal(writes, 0);
    assert.deepEqual(config.instances, []);
});

test("instance create restores configuration and registry when MCP registration fails", async () => {
    let config = createDefaultControlConfig();
    config.mcp.enabled = true;
    const writes: ControlConfig[] = [];
    const registry = new InstanceRegistry([]);
    const descriptor = {
        conversation: { close() {}, async list() { return []; }, async recordReport() {} },
        enabled: true,
        mcpEnabled: true,
        mcpPath: "/demo-local/mcp",
        modelExtensions: ["instance"],
        name: "demo-local",
        provider: "local",
        todo: {},
        worker: { snapshot: () => ({ status: "stopped" }) },
    } as never;
    const service = new InstanceCreateCoordinator({
        configStore: {
            async write(nextConfig) {
                writes.push(structuredClone(nextConfig));
                config = nextConfig;
            }
        },
        getConfig: () => config,
        getMcpHost: () => ({
            registerInstance() { throw new Error("MCP registration failed"); },
            unregisterInstance() {}
        }) as never,
        instanceConfigMapper: { map: () => descriptor } as never,
        instanceRegistry: registry,
        setConfig: (nextConfig) => { config = nextConfig; }
    });

    await assert.rejects(
        service.createInstance({
            mcp: { enabled: true },
            name: "demo-local",
            provider: "local",
        }),
        /MCP registration failed/u
    );
    assert.equal(writes.length, 2);
    assert.deepEqual(config.instances, []);
    assert.equal(registry.get("demo-local"), undefined);
});
