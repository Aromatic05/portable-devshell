import assert from "node:assert/strict";
import { access, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ControlConfigStore } from "../../../../src/config/store/index.ts";
import { ControlConfigValidator } from "../../../../src/config/engine/Validator.ts";
import { ControlGlobalTomlDocument } from "../../../../src/config/store/document/Global.ts";
import { ControlInstanceTomlDocument } from "../../../../src/config/store/document/Instance.ts";
import { ControlConfigTomlCodec } from "../../../../src/config/store/TomlCodec.ts";
import { createDefaultControlConfig } from "@portable-devshell/shared";
import {
    ControlPathHome,
    normalizeConfigGlobalDraft,
    normalizeConfigInstanceDraft,
    parseConfigInstanceDraft,
} from "@portable-devshell/shared";
import { createTestTempDirectory } from "../../../../../../test/TestTempDirectory.ts";

const fixturesDir = fileURLToPath(
    new URL("../../../fixtures/", import.meta.url),
);
const toml = new ControlConfigTomlCodec();
const globalDocument = new ControlGlobalTomlDocument();
const instanceDocument = new ControlInstanceTomlDocument();

async function assertRetiredConfigRejected(options: {
    globalSource?: string;
    instanceName?: string;
    instanceSource?: string;
}): Promise<void> {
    const homeDirectory = await createTestTempDirectory("control-legacy");
    try {
        const paths = new ControlPathHome(homeDirectory);
        const configFile = options.instanceName === undefined
            ? paths.configFile
            : paths.instanceConfigFile(options.instanceName);
        const source = options.globalSource ?? options.instanceSource;
        if (source === undefined) throw new Error("missing Config rejection fixture");
        if (options.instanceName !== undefined) {
            await writeFileWithParents(paths.configFile, await readFixture("config-valid.toml"));
        }
        await writeFileWithParents(configFile, source);
        await assert.rejects(
            new ControlConfigStore().readOrCreate(homeDirectory),
            (error: unknown) => {
                assert.equal((error as { code?: string }).code, "control.configParseFailed");
                assert.equal(
                    (error as { details?: { fieldPath?: string } }).details?.fieldPath,
                    "version",
                );
                return true;
            },
        );
        assert.equal(await readFile(configFile, "utf8"), source);
    } finally {
        await rm(homeDirectory, { force: true, recursive: true });
    }
}

test("readOrCreate persists a private control config", async () => {
    const homeDirectory = await createTestTempDirectory("control-home");

    try {
        await new ControlConfigStore().readOrCreate(homeDirectory);
        const paths = new ControlPathHome(homeDirectory);

        await access(paths.configFile);
        if (process.platform !== "win32") {
            assert.equal((await stat(paths.configFile)).mode & 0o777, 0o600);
            assert.equal(
                (await stat(paths.controlHomeDir)).mode & 0o777,
                0o700,
            );
        }
    } finally {
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

test("valid global and instance documents are assembled into canonical config", async () => {
    const homeDirectory = await createTestTempDirectory("control-home");

    try {
        const paths = new ControlPathHome(homeDirectory);
        await writeFileWithParents(
            paths.configFile,
            await readFixture("config-valid.toml"),
        );
        await writeFileWithParents(
            paths.instanceConfigFile("demo-local"),
            encodeInstance(createInstanceConfig()),
        );

        const config = await new ControlConfigStore().readOrCreate(
            homeDirectory,
        );
        const instance = config.instances[0];
        assert.equal(instance?.name, "demo-local");
        assert.equal(instance?.mcp.path, "/demo-local/mcp");
        assert.deepEqual(instance?.extensions.model, [
            "artifact",
            "instance",
            "mcp",
            "secret",
            "skill",
        ]);
        assert.equal(instance?.logs?.maxBytes, 33_554_432);
        assert.equal(instance?.approvalPolicy?.rules?.[0]?.source, "mcp");
        assert.equal(instance?.security.mode, "workspace");
    } finally {
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

test("instance TOML preserves MCP context selection mode", () => {
    const instance = normalizeConfigInstanceDraft({
        mcp: { contextMode: "openai-session" },
        name: "chatgpt-local",
        provider: "local",
    });
    const encoded = toml.encode(instanceDocument.encode(instance));
    assert.match(encoded, /contextMode = "openai-session"/u);
    assert.equal(
        instanceDocument.decode(toml.decode(encoded)).mcp?.contextMode,
        "openai-session",
    );
});

test("instance TOML preserves Workspace feature enablement", () => {
    const instance = normalizeConfigInstanceDraft({
        name: "workspace-local",
        provider: "local",
        workspace: { enabled: false },
    });
    const encoded = toml.encode(instanceDocument.encode(instance));
    assert.match(encoded, /\[workspace\][\s\S]*enabled = false/u);
    assert.equal(
        instanceDocument.decode(toml.decode(encoded)).workspace?.enabled,
        false,
    );
});

test("global v1 MCP auth cannot be loaded or silently upgraded", async () => {
    await assertRetiredConfigRejected({
        globalSource: [
            "version = 1", "[mcp]", "enabled = true",
            "[mcp.auth]", 'mode = "token"',
            'token = "0123456789abcdef0123456789abcdef"',
        ].join("\n"),
    });
});

test("retired instance v3 cannot regain default context authority", async () => {
    await assertRetiredConfigRejected({
        instanceName: "legacy-no-auth",
        instanceSource: toml.encode({
            enabled: true, mcp: { enabled: true },
            name: "legacy-no-auth", provider: "local", version: 3,
        }),
    });
});

test("retired instance v2 with workspace and MCP group policy is rejected unchanged", async () => {
    await assertRetiredConfigRejected({
        instanceName: "legacy-default",
        instanceSource: toml.encode({
            enabled: true,
            mcp: { enabled: true, tools: { capabilities: ["read"], groups: ["file", "todo"] } },
            name: "legacy-default", provider: "local", version: 2,
            workspace: "/tmp/legacy-default",
        }),
    });
});

test("retired instance v3 tool policy is not silently normalized into current permissions", async () => {
    await assertRetiredConfigRejected({
        instanceName: "canonical-groups",
        instanceSource: toml.encode({
            enabled: true,
            mcp: { enabled: true, tools: { capabilities: ["read"], groups: ["file"] } },
            name: "canonical-groups", provider: "local", version: 3,
        }),
    });
});

test("global TOML round-trips the independent WebUI enable switch", () => {
    const config = normalizeConfigGlobalDraft({
        mcp: { enabled: false },
        web: { enabled: true },
    });

    const encoded = toml.encode(globalDocument.encode(config));
    assert.match(encoded, /\[web\]\nauth = "none"\nenabled = true/u);
    assert.equal(
        globalDocument.decode(toml.decode(encoded)).web?.enabled,
        true,
    );
});

test("fresh defaults use token approval while legacy global config keeps TUI approval", () => {
    assert.deepEqual(createDefaultControlConfig().mcp.oauth2, {
        approval: "token",
    });
    assert.deepEqual(normalizeConfigGlobalDraft({}).mcp.oauth2, {
        approval: "tui",
    });

    const token = "o".repeat(48);
    const config = normalizeConfigGlobalDraft({
        mcp: {
            oauth2: { approval: "token", token },
        },
    });
    const encoded = toml.encode(globalDocument.encode(config));
    assert.match(encoded, /\[mcp\.oauth2\]/u);
    assert.match(encoded, /approval = "token"/u);
    assert.match(encoded, new RegExp(`token = "${token}"`, "u"));

    const decoded = normalizeConfigGlobalDraft(
        globalDocument.decode(toml.decode(encoded)),
    );
    assert.deepEqual(decoded.mcp.oauth2, { approval: "token", token });
});

test("global MCP OAuth2 TUI approval never persists an approval token", () => {
    const config = normalizeConfigGlobalDraft({
        mcp: { oauth2: { approval: "tui" } },
    });
    const encoded = toml.encode(globalDocument.encode(config));

    assert.match(encoded, /\[mcp\.oauth2\]/u);
    assert.match(encoded, /approval = "tui"/u);
    assert.doesNotMatch(encoded, /\[mcp\.oauth2\][\s\S]*token =/u);
});

test("global TOML keeps direct artifact transfer opt-in", () => {
    assert.equal(
        normalizeConfigGlobalDraft({}).control.artifactDirectTransfer,
        false,
    );

    const config = normalizeConfigGlobalDraft({
        control: { artifactDirectTransfer: true },
    });
    const encoded = toml.encode(globalDocument.encode(config));
    assert.match(encoded, /\[control\]\nartifactDirectTransfer = true/u);
    const decoded = normalizeConfigGlobalDraft(
        globalDocument.decode(toml.decode(encoded)),
    );
    assert.equal(decoded.control.artifactDirectTransfer, true);
});

test("global TOML round-trips web token auth without leaking other modes", () => {
    const token = "a".repeat(48);
    const config = normalizeConfigGlobalDraft({
        web: { auth: "token", enabled: true, token },
    });

    const encoded = toml.encode(globalDocument.encode(config));
    assert.match(encoded, /auth = "token"/u);
    assert.match(encoded, new RegExp(`token = "${token}"`, "u"));
    assert.doesNotMatch(encoded, /\[web\.oauth2\]/u);

    const decoded = normalizeConfigGlobalDraft(
        globalDocument.decode(toml.decode(encoded)),
    );
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
                resourceName: "aromatic-web",
            },
        },
    });

    const encoded = toml.encode(globalDocument.encode(config));
    assert.match(encoded, /auth = "oauth2"/u);
    assert.match(encoded, /\[web\.oauth2\]/u);
    assert.match(encoded, /resourceName = "aromatic-web"/u);
    assert.doesNotMatch(encoded, /token = /u);

    const decoded = normalizeConfigGlobalDraft(
        globalDocument.decode(toml.decode(encoded)),
    );
    assert.deepEqual(decoded.web.auth, {
        mode: "oauth2",
        oauth2: {
            documentationUrl: "https://docs.example.com/web",
            requiredScopes: ["web", "admin"],
            resourceName: "aromatic-web",
        },
    });
});

test("instance alerts survive Control config persistence", async () => {
    const homeDirectory = await createTestTempDirectory("control-alerts");
    const alerts = {
        intervalMs: 2_000,
        maxUncommittedChanges: 7,
        scripts: [
            {
                command: ["check-workspace", "--json"],
                id: "workspace",
                timeoutMs: 3_000,
            },
        ],
        workerMemoryBytes: 536_870_912,
    };
    const config = createDefaultControlConfig();
    config.instances = [{ ...createInstanceConfig(), alerts }];

    try {
        const store = new ControlConfigStore();
        await store.write(config, homeDirectory);
        const loaded = await store.readOrCreate(homeDirectory);

        assert.deepEqual(loaded.instances[0]?.alerts, alerts);
    } finally {
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

test("global TOML decode rejects web token residual alongside auth=none", () => {
    assert.throws(() =>
        globalDocument.decode(
            toml.decode(
                [
                    "version = 2",
                    "[web]",
                    'auth = "none"',
                    `token = "${"a".repeat(48)}"`,
                ].join("\n"),
            ),
        ),
    );
});

test("invalid TOML field type is reported with file and structural path", async () => {
    const homeDirectory = await createTestTempDirectory("control-home");

    try {
        const paths = new ControlPathHome(homeDirectory);
        await writeFileWithParents(
            paths.configFile,
            await readFixture("config-invalid.toml"),
        );

        await assert.rejects(
            new ControlConfigStore().readOrCreate(homeDirectory),
            (error: unknown) => {
                assert.equal(
                    (error as { code?: string }).code,
                    "control.configParseFailed",
                );
                assert.equal(
                    (
                        error as {
                            details?: {
                                configFile?: string;
                                fieldPath?: string;
                            };
                        }
                    ).details?.configFile,
                    paths.configFile,
                );
                assert.equal(
                    (error as { details?: { fieldPath?: string } }).details
                        ?.fieldPath,
                    "mcp.listenPort",
                );
                return true;
            },
        );
    } finally {
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

test("explicitly exposed MCP without auth remains a valid user choice", async () => {
    const homeDirectory = await createTestTempDirectory("control-home");

    try {
        const paths = new ControlPathHome(homeDirectory);
        await writeFileWithParents(
            paths.configFile,
            await readFixture("config-public-no-auth.toml"),
        );
        await assert.doesNotReject(
            new ControlConfigStore().readOrCreate(homeDirectory),
        );
    } finally {
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

test("OAuth2 document structure rejects unsupported external-provider fields", () => {
    assert.throws(() =>
        globalDocument.decode(
            toml.decode(
                [
                    "version = 1",
                    "[control]",
                    'logLevel = "info"',
                    "[mcp]",
                    "enabled = true",
                    'listenHost = "127.0.0.1"',
                    "listenPort = 17890",
                    "[mcp.auth]",
                    'mode = "oauth2"',
                ].join("\n"),
            ),
        ),
    );

    assert.throws(() =>
        globalDocument.decode(
            toml.decode(
                [
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
                    'resourceName = "aromatic"',
                ].join("\n"),
            ),
        ),
    );
});

test("instance name and audit limits are semantic validation rules", () => {
    const validator = new ControlConfigValidator();
    const invalidName = normalizeConfigInstanceDraft({
        name: "invalidname",
        provider: "local",
    });
    assert.throws(() =>
        validator.validate({
            ...createDefaultControlConfig(),
            instances: [invalidName],
        }),
    );

    const invalidLogs = createInstanceConfig();
    invalidLogs.logs!.maxBytes = 0;
    assert.throws(() =>
        validator.validate({
            ...createDefaultControlConfig(),
            instances: [invalidLogs],
        }),
    );
});

test("instance alert limits are rejected by Control before reaching a worker", () => {
    const validator = new ControlConfigValidator();
    const validateAlerts = (
        alerts: NonNullable<ReturnType<typeof createInstanceConfig>["alerts"]>,
    ) =>
        validator.validate({
            ...createDefaultControlConfig(),
            instances: [{ ...createInstanceConfig(), alerts }],
        });

    assert.throws(() => validateAlerts({ intervalMs: 999 }));
    assert.throws(() =>
        validateAlerts({
            scripts: [{ command: ["check"], id: "check", timeoutMs: 0 }],
        }),
    );
    assert.throws(() => validateAlerts({ maxUncommittedChanges: -1 }));
    assert.throws(() => validateAlerts({ workerMemoryBytes: -1 }));
});

test("unknown and legacy instance fields are rejected instead of silently ignored", () => {
    assert.throws(() =>
        instanceDocument.decode(
            toml.decode(
                [
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
                    'mode = "patch"',
                ].join("\n"),
            ),
        ),
    );

    assert.throws(() =>
        instanceDocument.decode(
            toml.decode(
                [
                    "version = 2",
                    'name = "demo-ssh"',
                    "enabled = true",
                    'provider = "ssh"',
                    'workspace = "/srv/workspace"',
                    'host = "demo"',
                ].join("\n"),
            ),
        ),
    );
});

test("version 3 instance documents reject persistent workspace authority", () => {
    assert.throws(() =>
        instanceDocument.decode(
            toml.decode(
                [
                    "version = 3",
                    'name = "demo-local"',
                    "enabled = true",
                    'provider = "local"',
                    'workspace = "/tmp/demo"',
                ].join("\n"),
            ),
        ),
    );
});

test("SSH instance normalization requires ssh.command", () => {
    assert.throws(() =>
        normalizeConfigInstanceDraft(
            parseConfigInstanceDraft({
                name: "demo-ssh",
                provider: "ssh",
            }),
        ),
    );
});

async function readFixture(name: string): Promise<string> {
    return await readFile(join(fixturesDir, name), "utf8");
}

async function writeFileWithParents(
    path: string,
    source: string,
): Promise<void> {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, source, "utf8");
}

function encodeInstance(
    instance: ReturnType<typeof createInstanceConfig>,
): string {
    return toml.encode(instanceDocument.encode(instance));
}

function createInstanceConfig() {
    return normalizeConfigInstanceDraft({
        approvalPolicy: {
            mode: "ask",
            rules: [
                {
                    decision: "deny",
                    match: "exact",
                    source: "mcp",
                    toolName: "bash_run",
                },
            ],
        },
        env: { DEMO: "1" },
        logs: {
            eventBufferSize: 50,
            maxBytes: 33_554_432,
            retentionDays: 14,
        },
        mcp: {
            enabled: true,
        },
        name: "demo-local",
        provider: "local",
        security: { mode: "workspace" },
    });
}
