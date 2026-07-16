import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
    ControlConfigStore,
    ControlConfigValidator,
    ControlGlobalTomlDocument,
    ControlInstanceTomlDocument,
    ControlConfigTomlCodec,
    createDefaultControlConfig
} from "../../dist/testing.js";
import {
    ControlPathHome,
    ControlPathRuntime,
    normalizeConfigGlobalDraft,
    normalizeConfigInstanceDraft,
    parseConfigInstanceDraft
} from "@portable-devshell/shared";

const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));
const toml = new ControlConfigTomlCodec();
const globalDocument = new ControlGlobalTomlDocument();
const instanceDocument = new ControlInstanceTomlDocument();

test("default config is generated at the fixed control config path", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "portable-devshell-control-home-"));

    try {
        const config = await new ControlConfigStore().readOrCreate(homeDirectory);
        const paths = new ControlPathHome(homeDirectory);

        assert.deepEqual(config, createDefaultControlConfig());
        assert.equal(paths.configFile, join(homeDirectory, ".devshell", "control", "config.toml"));
        assert.equal(new ControlPathRuntime("/tmp/runtime-task-8").socketFile, "/tmp/runtime-task-8/portable-devshell/control.sock");
        assert.equal(
            new ControlPathRuntime("").socketFile,
            join(tmpdir(), `portable-devshell-${typeof process.getuid === "function" ? process.getuid() : process.env.USER ?? process.env.USERNAME ?? "user"}`, "control.sock")
        );

        await access(paths.configFile);
        assert.match(await readFile(paths.configFile, "utf8"), /\[mcp\]/u);
    } finally {
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

test("valid global and instance documents are assembled into canonical config", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "portable-devshell-control-home-"));

    try {
        const paths = new ControlPathHome(homeDirectory);
        await writeFileWithParents(paths.configFile, await readFixture("config-valid.toml"));
        await writeFileWithParents(paths.instanceConfigFile("demo-local"), encodeInstance(createInstanceConfig("/tmp/demo")));

        const config = await new ControlConfigStore().readOrCreate(homeDirectory);
        const instance = config.instances[0];
        assert.equal(instance?.name, "demo-local");
        assert.equal(instance?.mcp.path, "/demo-local/mcp");
        assert.deepEqual(instance?.mcp.tools.groups, ["file", "bash", "artifact"]);
        assert.equal(instance?.logs?.maxBytes, 33_554_432);
        assert.equal(instance?.approvalPolicy?.rules?.[0]?.source, "mcp");
        assert.equal(instance?.security.mode, "workspace");
    } finally {
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

test("invalid TOML field type is reported with file and structural path", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "portable-devshell-control-home-"));

    try {
        const paths = new ControlPathHome(homeDirectory);
        await writeFileWithParents(paths.configFile, await readFixture("config-invalid.toml"));

        await assert.rejects(new ControlConfigStore().readOrCreate(homeDirectory), (error: unknown) => {
            assert.equal((error as { code?: string }).code, "control.configParseFailed");
            assert.match((error as { message?: string }).message ?? "", /mcp\.listenPort must be an integer/u);
            assert.equal((error as { details?: { configFile?: string; fieldPath?: string } }).details?.configFile, paths.configFile);
            assert.equal((error as { details?: { fieldPath?: string } }).details?.fieldPath, "mcp.listenPort");
            return true;
        });
    } finally {
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

test("public MCP without auth is rejected by semantic validation", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "portable-devshell-control-home-"));

    try {
        const paths = new ControlPathHome(homeDirectory);
        await writeFileWithParents(paths.configFile, await readFixture("config-public-no-auth.toml"));
        await assert.rejects(
            new ControlConfigStore().readOrCreate(homeDirectory),
            /mcp\.auth\.mode must not be none when MCP is publicly exposed/u
        );
    } finally {
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

test("OAuth2 document structure is parsed before normalization", () => {
    assert.throws(
        () => globalDocument.decode(toml.decode([
            "version = 1",
            "[control]",
            'logLevel = "info"',
            "[mcp]",
            "enabled = true",
            'listenHost = "127.0.0.1"',
            "listenPort = 17890",
            "[mcp.auth]",
            'mode = "oauth2"'
        ].join("\n"))),
        /mcp\.auth\.oauth2 is required when mode=oauth2/u
    );

    const config = normalizeConfigGlobalDraft(globalDocument.decode(toml.decode([
        "version = 1",
        "[control]",
        'logLevel = "info"',
        "[mcp]",
        "enabled = true",
        'listenHost = "127.0.0.1"',
        "listenPort = 17890",
        "[mcp.auth]",
        'mode = "oauth2"',
        "[mcp.auth.oauth2]",
        'issuer = "http://127.0.0.1:9000"',
        'audience = "aromatic-mcp"',
        'resourceName = "aromatic"',
        'requiredScopes = ["mcp", "mcp"]'
    ].join("\n"))));

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

test("instance name and audit limits are semantic validation rules", () => {
    const validator = new ControlConfigValidator();
    const invalidName = normalizeConfigInstanceDraft({
        name: "invalidname",
        provider: "local",
        workspace: "/tmp/demo"
    });
    assert.throws(
        () => validator.validate({ ...createDefaultControlConfig(), instances: [invalidName] }),
        /instances\[0\]\.name must contain at least one '-'/u
    );

    const invalidLogs = createInstanceConfig("/tmp/demo");
    invalidLogs.logs.maxBytes = 0;
    assert.throws(
        () => validator.validate({ ...createDefaultControlConfig(), instances: [invalidLogs] }),
        /logs\.maxBytes must be an integer of at least 1048576/u
    );
});

test("unknown and legacy instance fields are rejected instead of silently ignored", () => {
    assert.throws(
        () => instanceDocument.decode(toml.decode([
            "version = 2",
            'name = "demo-local"',
            "enabled = true",
            'provider = "local"',
            'workspace = "/tmp/demo"',
            "[mcp]",
            "enabled = true",
            "[mcp.tools]",
            'groups = ["file"]',
            'capabilities = ["read", "write"]',
            "[tools.fileEdit]",
            'mode = "patch"'
        ].join("\n"))),
        /tools\.fileEdit is not supported/u
    );

    assert.throws(
        () => instanceDocument.decode(toml.decode([
            "version = 2",
            'name = "demo-ssh"',
            "enabled = true",
            'provider = "ssh"',
            'workspace = "/srv/workspace"',
            'host = "demo"'
        ].join("\n"))),
        /host is not supported; use ssh\.command/u
    );
});

test("SSH instance normalization requires ssh.command", () => {
    assert.throws(
        () => normalizeConfigInstanceDraft(parseConfigInstanceDraft({
            name: "demo-ssh",
            provider: "ssh",
            workspace: "/srv/workspace"
        })),
        /ssh\.command is required/u
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

function encodeInstance(instance: ReturnType<typeof createInstanceConfig>): string {
    return toml.encode(instanceDocument.encode(instance));
}

function createInstanceConfig(workspace: string) {
    return normalizeConfigInstanceDraft({
        approvalPolicy: {
            mode: "ask",
            rules: [
                {
                    decision: "deny",
                    match: "exact",
                    source: "mcp",
                    toolName: "bash_run"
                }
            ]
        },
        env: { DEMO: "1" },
        logs: {
            eventBufferSize: 50,
            maxBytes: 33_554_432,
            retentionDays: 14
        },
        mcp: {
            enabled: true,
            tools: {
                capabilities: ["read", "write", "execute"],
                groups: ["file", "bash", "artifact"]
            }
        },
        name: "demo-local",
        provider: "local",
        security: { mode: "workspace" },
        workspace
    });
}
