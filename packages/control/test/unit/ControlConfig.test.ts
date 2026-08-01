import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
    ControlConfigStore,
    ControlConfigValidator,
    ControlGlobalTomlDocument,
    ControlInstanceTomlDocument,
    ControlConfigTomlCodec,
    createDefaultControlConfig
} from "../../src/testing.ts";
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
        assert.equal(new ControlPathRuntime("/tmp/runtime-task-8", "linux", {}).socketFile, "/tmp/runtime-task-8/portable-devshell/control.sock");
        assert.equal(
            new ControlPathRuntime("", "linux", process.env).socketFile,
            posix.join(
                process.platform === "win32" ? "/tmp" : tmpdir(),
                `portable-devshell-${typeof process.getuid === "function" ? process.getuid() : process.env.USER ?? process.env.USERNAME ?? "user"}`,
                "control.sock"
            )
        );

        await access(paths.configFile);
        const generated = await readFile(paths.configFile, "utf8");
        assert.match(generated, /\[mcp\]/u);
        assert.match(generated, /\[web\]\nauth = "none"\nenabled = false/u);
        if (process.platform !== "win32") {
            assert.equal((await stat(paths.configFile)).mode & 0o777, 0o600);
            assert.equal((await stat(paths.controlHomeDir)).mode & 0o777, 0o700);
        }
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

test("version 1 global MCP auth migrates to each enabled namespace and writes version 2", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "portable-devshell-control-home-"));
    const token = "0123456789abcdef0123456789abcdef";

    try {
        const paths = new ControlPathHome(homeDirectory);
        await writeFileWithParents(paths.configFile, [
            "version = 1",
            "[control]",
            'logLevel = "info"',
            "[mcp]",
            "enabled = true",
            'listenHost = "127.0.0.1"',
            "listenPort = 17890",
            "[mcp.auth]",
            'mode = "token"',
            `token = "${token}"`,
            "[web]",
            "enabled = true"
        ].join("\n"));
        await writeFileWithParents(paths.instanceConfigFile("demo-local"), encodeInstance(createInstanceConfig("/tmp/demo")));

        const config = await new ControlConfigStore().readOrCreate(homeDirectory);
        assert.deepEqual(config.instances[0]?.mcp.auth, { mode: "token", token });
        const global = await readFile(paths.configFile, "utf8");
        const instance = await readFile(paths.instanceConfigFile("demo-local"), "utf8");
        assert.match(global, /^version = 2$/mu);
        assert.doesNotMatch(global, /\[mcp\.auth\]/u);
        assert.match(instance, /auth = "token"/u);
    } finally {
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

test("version 2 legacy default MCP groups gain context without widening custom allowlists", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "portable-devshell-control-home-"));

    try {
        const paths = new ControlPathHome(homeDirectory);
        await writeFileWithParents(paths.configFile, await readFixture("config-valid.toml"));
        await writeFileWithParents(
            paths.instanceConfigFile("legacy-default"),
            toml.encode({
                enabled: true,
                mcp: {
                    enabled: true,
                    tools: {
                        capabilities: ["read", "write", "execute"],
                        groups: ["file", "bash", "artifact", "tmux", "todo"]
                    }
                },
                name: "legacy-default",
                provider: "local",
                version: 2,
                workspace: "/tmp/legacy-default"
            })
        );
        await writeFileWithParents(
            paths.instanceConfigFile("custom-policy"),
            toml.encode({
                enabled: true,
                mcp: {
                    enabled: true,
                    tools: { capabilities: ["read"], groups: ["file", "todo"] }
                },
                name: "custom-policy",
                provider: "local",
                version: 2,
                workspace: "/tmp/custom-policy"
            })
        );

        const config = await new ControlConfigStore().readOrCreate(homeDirectory);
        assert.deepEqual(
            config.instances.find((instance) => instance.name === "legacy-default")?.mcp.tools.groups,
            ["file", "bash", "artifact", "tmux", "todo", "context"]
        );
        assert.deepEqual(
            config.instances.find((instance) => instance.name === "custom-policy")?.mcp.tools.groups,
            ["file", "todo"]
        );
    } finally {
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

test("global TOML round-trips the independent WebUI enable switch", () => {
    const config = normalizeConfigGlobalDraft({
        mcp: { enabled: false },
        web: { enabled: true }
    });

    const encoded = toml.encode(globalDocument.encode(config));
    assert.match(encoded, /\[web\]\nauth = "none"\nenabled = true/u);
    assert.equal(globalDocument.decode(toml.decode(encoded)).web?.enabled, true);
});

test("global TOML round-trips web token auth without leaking other modes", () => {
    const token = "a".repeat(48);
    const config = normalizeConfigGlobalDraft({
        web: { auth: "token", enabled: true, token }
    });

    const encoded = toml.encode(globalDocument.encode(config));
    assert.match(encoded, /auth = "token"/u);
    assert.match(encoded, new RegExp(`token = "${token}"`, "u"));
    assert.doesNotMatch(encoded, /\[web\.oauth2\]/u);

    const decoded = normalizeConfigGlobalDraft(globalDocument.decode(toml.decode(encoded)));
    assert.deepEqual(decoded.web.auth, { mode: "token", token });
});

test("global TOML round-trips web oauth2 auth with a flat web.oauth2 table", () => {
    const config = normalizeConfigGlobalDraft({
        web: {
            auth: "oauth2",
            enabled: true,
            oauth2: {
                documentationUrl: "https://docs.example.com/web",
                requiredScopes: ["web", "admin"],
                resourceName: "aromatic-web"
            }
        }
    });

    const encoded = toml.encode(globalDocument.encode(config));
    assert.match(encoded, /auth = "oauth2"/u);
    assert.match(encoded, /\[web\.oauth2\]/u);
    assert.match(encoded, /resourceName = "aromatic-web"/u);
    assert.doesNotMatch(encoded, /token = /u);

    const decoded = normalizeConfigGlobalDraft(globalDocument.decode(toml.decode(encoded)));
    assert.deepEqual(decoded.web.auth, {
        mode: "oauth2",
        oauth2: {
            documentationUrl: "https://docs.example.com/web",
            requiredScopes: ["web", "admin"],
            resourceName: "aromatic-web"
        }
    });
});

test("global TOML decode rejects web token residual alongside auth=none", () => {
    assert.throws(
        () =>
            globalDocument.decode(toml.decode([
                "version = 2",
                "[web]",
                'auth = "none"',
                `token = "${"a".repeat(48)}"`
            ].join("\n"))),
        /must not configure oauth2 or token when auth=none/u
    );
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

test("explicitly exposed MCP without auth remains a valid user choice", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "portable-devshell-control-home-"));

    try {
        const paths = new ControlPathHome(homeDirectory);
        await writeFileWithParents(paths.configFile, await readFixture("config-public-no-auth.toml"));
        await assert.doesNotReject(new ControlConfigStore().readOrCreate(homeDirectory));
    } finally {
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

test("OAuth2 document structure rejects unsupported external-provider fields", () => {
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
            'mode = "oauth2"',
            "[mcp.auth.oauth2]",
            'issuer = "http://127.0.0.1:9000"',
            'resourceName = "aromatic"'
        ].join("\n"))),
        /mcp\.auth\.oauth2\.issuer is not supported/u
    );
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
    invalidLogs.logs!.maxBytes = 0;
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
