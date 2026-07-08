import assert from "node:assert/strict";
import test from "node:test";

import { InstanceRegistry, createDefaultControlConfig } from "../../dist/index.js";
import { ControlInstanceCreateService } from "../../dist/control/ControlInstanceCreateService.js";

test("instance create schema exposes supported container modes without running container attach", () => {
    const service = createService();
    const schema = service.getSchema();

    assert.deepEqual(schema.container.modes, [
        "preset",
        "dockerfile",
        "compose",
        "existingImage",
        "existingStoppedContainer"
    ]);
    assert.equal(schema.container.presets.some((entry) => entry.preset === "arch"), true);
});

test("instance create validates docker preset drafts into container config", () => {
    const service = createService();

    const summary = service.validateDraft({
        container: {
            mode: "preset",
            preset: "arch"
        },
        name: "demo-docker",
        provider: "docker",
        workspace: "/workspace"
    });

    assert.deepEqual(summary.container, {
        containerName: "devshell-demo-docker",
        env: undefined,
        image: "archlinux:latest",
        mode: "preset",
        mounts: undefined,
        network: undefined,
        preset: "arch",
        user: undefined
    });
    assert.equal(summary.provider, "docker");
});

test("instance create validates existing stopped container drafts with adoptLifecycle", () => {
    const service = createService();

    const summary = service.validateDraft({
        container: {
            adoptLifecycle: true,
            containerName: "my-stopped-container",
            mode: "existingStoppedContainer"
        },
        name: "demo-podman",
        provider: "podman",
        workspace: "/workspace"
    });

    assert.deepEqual(summary.container, {
        adoptLifecycle: true,
        containerName: "my-stopped-container",
        mode: "existingStoppedContainer"
    });
});

function createService() {
    let config = createDefaultControlConfig();

    return new ControlInstanceCreateService({
        configStore: {
            async readOrCreate() {
                return config;
            },
            async write(nextConfig) {
                config = nextConfig;
            }
        },
        getConfig: () => config,
        getMcpHost: () => undefined,
        instanceRegistry: new InstanceRegistry([]),
        setConfig: (nextConfig) => {
            config = nextConfig;
        }
    });
}
