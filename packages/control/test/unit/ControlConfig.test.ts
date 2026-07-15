import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
    ControlConfigStore,
    ControlInstanceTomlCodec,
    ControlConfigTomlCodec,
    ControlConfigValidator,
    ControlPathHome,
    ControlPathRuntime,
    createDefaultControlConfig
} from "../../dist/index.js";

const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));

test("default config is generated at the fixed control config path", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "portable-devshell-control-home-"));

    try {
        const store = new ControlConfigStore();
        const config = await store.readOrCreate(homeDirectory);
        const paths = new ControlPathHome(homeDirectory);

        assert.deepEqual(config, createDefaultControlConfig());
        assert.equal(paths.configFile, join(homeDirectory, ".devshell", "control", "config.toml"));
        assert.equal(new ControlPathRuntime("/tmp/runtime-task-8").socketFile, "/tmp/runtime-task-8/portable-devshell/control.sock");
        assert.equal(
            new ControlPathRuntime("").socketFile,
            join(tmpdir(), `portable-devshell-${typeof process.getuid === "function" ? process.getuid() : process.env.USER ?? process.env.USERNAME ?? "user"}`, "control.sock")
        );

        await access(paths.configFile);
        const source = await readFile(paths.configFile, "utf8");
        assert.match(source, /\[mcp\]/u);
    } finally {
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

test("valid config fixture is loaded", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "portable-devshell-control-home-"));

    try {
        const fixture = await readFixture("config-valid.toml");
        const paths = new ControlPathHome(homeDirectory);

        await writeFileWithParents(paths.configFile, fixture);
        await writeFileWithParents(
            paths.instanceConfigFile("demo-local"),
            new ControlInstanceTomlCodec().encode(createInstanceConfig("/tmp/demo"))
        );

        const config = await new ControlConfigStore().readOrCreate(homeDirectory);

        assert.equal(config.instances[0]?.name, "demo-local");
        assert.deepEqual(config.instances[0]?.mcp.tools.groups, ["file", "bash", "artifact"]);
        assert.deepEqual(config.instances[0]?.mcp.tools.capabilities, ["read", "write", "execute"]);
        assert.equal(config.instances[0]?.logs?.eventBufferSize, 50);
        assert.equal(config.instances[0]?.logs?.maxBytes, 33_554_432);
        assert.equal(config.instances[0]?.logs?.retentionDays, 14);
        assert.equal(config.instances[0]?.approvalPolicy?.mode, "ask");
        assert.equal(config.instances[0]?.approvalPolicy?.rules?.[0]?.source, "mcp");
        assert.equal(config.instances[0]?.security?.mode, "workspace");
        assert.equal(config.instances[0]?.workspace, "/tmp/demo");
    } finally {
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

test("invalid config fixture is rejected", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "portable-devshell-control-home-"));

    try {
        const paths = new ControlPathHome(homeDirectory);
        await writeFileWithParents(paths.configFile, await readFixture("config-invalid.toml"));

        await assert.rejects(new ControlConfigStore().readOrCreate(homeDirectory), (error: unknown) => {
            assert.equal(typeof error, "object");
            assert.equal((error as { code?: string }).code, "control.configParseFailed");
            assert.equal((error as { message?: string }).message, "mcp.listenPort must be an integer");
            assert.deepEqual((error as { details?: unknown }).details, {
                configFile: paths.configFile,
                fieldPath: "mcp.listenPort",
                phase: "decode"
            });
            return true;
        });
    } finally {
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

test("public MCP without auth is rejected", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "portable-devshell-control-home-"));

    try {
        const paths = new ControlPathHome(homeDirectory);
        await writeFileWithParents(paths.configFile, await readFixture("config-public-no-auth.toml"));

        await assert.rejects(new ControlConfigStore().readOrCreate(homeDirectory), /Public MCP exposure requires authentication\./u);
    } finally {
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

test("oauth2 config requires nested issuer and audience settings", () => {
    const codec = new ControlConfigTomlCodec();
    const validator = new ControlConfigValidator();

    assert.throws(
        () =>
            validator.validate({
                ...createDefaultControlConfig(),
                mcp: {
                    ...createDefaultControlConfig().mcp,
                    auth: {
                        mode: "oauth2"
                    },
                    enabled: true
                }
            }),
        /mcp\.auth\.oauth2 is required when mcp\.auth\.mode=oauth2/u
    );

    const config = codec.decode(
        [
            "version = 1",
            "",
            "[control]",
            'logLevel = "info"',
            "",
            "[mcp]",
            "enabled = true",
            'listenHost = "127.0.0.1"',
            "listenPort = 17890",
            'publicBaseUrl = "http://127.0.0.1:17890"',
            "",
            "[mcp.auth]",
            'mode = "oauth2"',
            "",
            "[mcp.auth.oauth2]",
            'issuer = "http://127.0.0.1:9000"',
            'audience = "aromatic-mcp"',
            'resourceName = "aromatic"',
            'requiredScopes = ["mcp"]',
            ""
        ].join("\n")
    );

    assert.deepEqual(config.mcp.auth, {
        mode: "oauth2",
        oauth2: {
            audience: "aromatic-mcp",
            documentationUrl: undefined,
            issuer: "http://127.0.0.1:9000",
            jwksUri: undefined,
            requiredScopes: ["mcp"],
            resourceName: "aromatic"
        }
    });
});

test("instance name without dash is rejected", () => {
    const validator = new ControlConfigValidator();
    const config = createDefaultControlConfig();

    config.instances.push({
        enabled: true,
        mcp: { enabled: true, tools: { capabilities: ["read", "write", "execute"], groups: ["file", "bash", "artifact"] } },
        name: "invalidname",
        provider: "local",
        workspace: "/tmp/demo"
    });

    assert.throws(
        () => validator.validate(config),
        (error: unknown) => {
            assert.equal(typeof error, "object");
            assert.equal((error as { code?: string }).code, "control.configValidationFailed");
            assert.equal((error as { message?: string }).message, "instance name must include '-': invalidname");
            assert.deepEqual((error as { details?: unknown }).details, {
                fieldPath: "instance",
                phase: "validate"
            });
            return true;
        }
    );
});

test("instance security mode must be valid", () => {
    const validator = new ControlConfigValidator();
    const config = createDefaultControlConfig();

    config.instances.push({
        enabled: true,
        mcp: { enabled: true, tools: { capabilities: ["read", "write", "execute"], groups: ["file", "bash", "artifact"] } },
        name: "demo-local",
        provider: "local",
        security: {
            mode: "invalid"
        },
        workspace: "/tmp/demo"
    });

    assert.throws(() => validator.validate(config), /security\.mode must be one of disabled, workspace/u);
});

test("instance audit storage limits must be positive integers", () => {
    const config = createDefaultControlConfig();
    const instance = createInstanceConfig("/tmp/demo");
    instance.logs.maxBytes = 0;

    assert.throws(
        () => new ControlConfigValidator().validate({ ...config, instances: [instance] }),
        /logs\.maxBytes must be an integer of at least 1048576/u
    );
});

test("legacy tools.fileEdit config is ignored and removed on encode", () => {
    const codec = new ControlInstanceTomlCodec();
    const decoded = codec.decode(
        [
            "version = 2",
            'name = "demo-local"',
            "enabled = true",
            'provider = "local"',
            'workspace = "/tmp/demo"',
            "",
            "[mcp]",
            "enabled = true",
            "",
            "[mcp.tools]",
            'groups = ["file"]',
            'capabilities = ["read", "write"]',
            "",
            "[tools.fileEdit]",
            'mode = "patch"',
            "",
            "[tools.scheduler]",
            "maxRunning = 2",
            ""
        ].join("\n")
    );

    assert.equal(decoded.tools?.scheduler?.maxRunning, 2);
    assert.equal("fileEdit" in (decoded.tools ?? {}), false);
    const encoded = codec.encode(decoded);
    assert.doesNotMatch(encoded, /fileEdit/u);
    assert.match(encoded, /\[tools\.scheduler\]/u);
});

test("ssh instance config requires ssh.command and rejects legacy host fields", () => {
    const validator = new ControlConfigValidator();

    assert.throws(
        () =>
            validator.validate({
                ...createDefaultControlConfig(),
                instances: [
                    {
                        enabled: true,
                        mcp: { enabled: true, tools: { capabilities: ["read", "write", "execute"], groups: ["file", "bash", "artifact"] } },
                        name: "demo-ssh",
                        provider: "ssh",
                        workspace: "/srv/workspace"
                    }
                ]
            }),
        /requires ssh\.command/u
    );

    assert.throws(
        () =>
            new ControlInstanceTomlCodec().decode(
                [
                    "version = 2",
                    'name = "demo-ssh"',
                    "enabled = true",
                    'provider = "ssh"',
                    'workspace = "/srv/workspace"',
                    'host = "demo"',
                    "",
                    "[mcp]",
                    "enabled = true",
                    "",
                    "[mcp.tools]",
                    'groups = ["file", "bash", "artifact"]',
                    'capabilities = ["read", "write", "execute"]',
                    ""
                ].join("\n")
            ),
        /host is not supported; use ssh\.command/u
    );
});

async function readFixture(name: string): Promise<string> {
    return await readFile(join(fixturesDir, name), "utf8");
}

async function writeFileWithParents(path: string, source: string): Promise<void> {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, source, "utf8");
}

function createInstanceConfig(workspace: string) {
    return {
        approvalPolicy: {
            mode: "ask" as const,
            rules: [
                {
                    decision: "deny" as const,
                    match: "exact" as const,
                    source: "mcp" as const,
                    toolName: "bash_run"
                }
            ]
        },
        enabled: true,
        env: {
            DEMO: "1"
        },
        logs: {
            eventBufferSize: 50,
            maxBytes: 33_554_432,
            retentionDays: 14
        },
        mcp: { enabled: true, tools: { capabilities: ["read", "write", "execute"], groups: ["file", "bash", "artifact"] } },
        name: "demo-local",
        provider: "local" as const,
        security: {
            mode: "workspace"
        },
        workspace
    };
}
