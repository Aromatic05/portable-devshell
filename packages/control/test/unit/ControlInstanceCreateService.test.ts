import assert from "node:assert/strict";
import test from "node:test";

import {
    InstanceRegistry,
    createDefaultControlConfig,
} from "../../src/testing.ts";
import { InstanceCreateCoordinator } from "../../src/control/instance/create/InstanceCreateCoordinator.ts";
import { normalizeConfigInstanceDraft, type ControlConfig } from "@portable-devshell/shared";

test("instance create schema exposes supported container modes without running container attach", () => {
    const service = createService("linux");
    const schema = service.getSchema();

    assert.deepEqual(schema.container.modes, [
        "preset",
        "dockerfile",
        "compose",
        "existingImage",
        "existingStoppedContainer",
    ]);
    assert.equal(
        schema.container.presets.some((entry) => entry.preset === "arch"),
        true,
    );
    assert.deepEqual(schema.defaultMcpGroups, [
        "file",
        "bash",
        "artifact",
        "tmux",
        "todo",
    ]);
});

test("Windows instance create schema exposes only supported providers", () => {
    const schema = createService("win32").getSchema();
    assert.deepEqual(schema.providers, ["local", "ssh", "reverse"]);
});

test("instance create validates docker preset drafts into container config", () => {
    const service = createService("linux");

    const summary = service.validateDraft({
        container: {
            mode: "preset",
            preset: "arch",
        },
        name: "demo-docker",
        provider: "docker",
        workspace: "/workspace",
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
        workspace: "/workspace",
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
        workspace: "/workspace"
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
            workspace: "/workspace/demo"
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
        enabled: true,
        mcpCapabilities: ["read"],
        mcpEnabled: true,
        mcpGroups: ["file"],
        mcpPath: "/demo-local/mcp",
        name: "demo-local",
        provider: "local",
        todo: {},
        worker: { snapshot: () => ({ status: "stopped" }) },
        workspace: "/workspace/demo"
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
            workspace: "/workspace/demo"
        }),
        /MCP registration failed/u
    );
    assert.equal(writes.length, 2);
    assert.deepEqual(config.instances, []);
    assert.equal(registry.get("demo-local"), undefined);
});

test("MCP instance_create creates only SSH and strips instance management from inherited policy", async () => {
    let config = createDefaultControlConfig();
    config.mcp.enabled = true;
    config.instances.push(
        normalizeConfigInstanceDraft({
            approvalPolicy: {
                mode: "ask",
                rules: [
                    {
                        decision: "ask",
                        match: "exact",
                        source: "mcp",
                        toolName: "bash_run",
                    },
                ],
            },
            enabled: true,
            mcp: {
                enabled: true,
                tools: {
                    capabilities: ["read", "write", "execute", "manage"],
                    groups: ["file", "bash", "artifact", "instance"],
                },
            },
            name: "main-pc",
            provider: "local",
            security: {
                mode: "workspace",
            },
            workspace: "/home/dev/main",
        }),
    );
    const registry = new InstanceRegistry([]);
    const registered: Array<Record<string, unknown>> = [];
    const gateway = {} as never;
    const service = new InstanceCreateCoordinator({
        configStore: {
            async write(nextConfig) {
                config = nextConfig;
            },
        },
        getConfig: () => config,
        getMcpHost: () =>
            ({
                registerInstance(instance: Record<string, unknown>) {
                    registered.push(instance);
                },
            }) as never,
        getMcpInstanceGateway: () => gateway,
        instanceRegistry: registry,
        setConfig: (nextConfig) => {
            config = nextConfig;
        },
    });

    const result = await service.createSshInstanceFromMcp("main-pc", {
        host: "server.example.com",
        identityFile: "/home/dev/.ssh/work key",
        name: "remote-server",
        port: 2222,
        user: "dev",
        workspace: "/srv/project",
    });

    assert.equal(result.name, "remote-server");
    const created = config.instances.find(
        (instance) => instance.name === "remote-server",
    );
    assert.ok(created !== undefined);
    assert.equal(created.provider, "ssh");
    assert.equal(created.mcp.enabled, true);
    assert.equal(created.mcp.path, "/remote-server/mcp");
    assert.deepEqual(created.mcp.tools.groups, ["file", "bash", "artifact"]);
    assert.deepEqual(created.mcp.tools.capabilities, [
        "read",
        "write",
        "execute",
    ]);
    assert.equal(created.security?.mode, "workspace");
    assert.deepEqual(
        created.approvalPolicy,
        config.instances[0]?.approvalPolicy,
    );
    assert.equal(
        created.ssh?.command,
        "'ssh' '-p' '2222' '-i' '/home/dev/.ssh/work key' 'dev@server.example.com'",
    );
    assert.ok(registry.get("remote-server") !== undefined);
    assert.equal(registered.length, 1);
    assert.equal(registered[0]?.gateway, gateway);
    assert.deepEqual(registered[0]?.policy, {
        capabilities: ["read", "write", "execute"],
        groups: ["file", "bash", "artifact"],
    });
});

test("MCP instance_create rejects SSH option injection through host and user", async () => {
    const service = createMcpCreateService();

    await assert.rejects(
        service.createSshInstanceFromMcp("main-pc", {
            host: "-oProxyCommand=sh",
            name: "remote-server",
            workspace: "/srv/project",
        }),
        /host must not contain whitespace, control characters, or begin with '-'/u,
    );

    await assert.rejects(
        service.createSshInstanceFromMcp("main-pc", {
            host: "server.example.com",
            name: "remote-server",
            user: "dev user",
            workspace: "/srv/project",
        }),
        /user must not contain whitespace, control characters, or begin with '-'/u,
    );
});

function createMcpCreateService() {
    let config = createDefaultControlConfig();
    config.instances.push(
        normalizeConfigInstanceDraft({
            enabled: true,
            mcp: {
                enabled: true,
                tools: {
                    capabilities: ["manage"],
                    groups: ["instance"],
                },
            },
            name: "main-pc",
            provider: "local",
            workspace: "/home/dev/main",
        }),
    );

    return new InstanceCreateCoordinator({
        configStore: {
            async write(nextConfig) {
                config = nextConfig;
            },
        },
        getConfig: () => config,
        getMcpHost: () => undefined,
        instanceRegistry: new InstanceRegistry([]),
        setConfig: (nextConfig) => {
            config = nextConfig;
        },
    });
}
