import assert from "node:assert/strict";
import test from "node:test";

import {
    ConfigInputError,
    applyConfigInstancePatch,
    normalizeConfigDraft,
    normalizeConfigInstanceDraft,
    parseConfigDraft,
    parseConfigInstancePatch,
    validateConfigSemantics
} from "@portable-devshell/shared";

test("config parser trims values and preserves explicit patch removals", () => {
    const parsed = parseConfigDraft({
        control: { logLevel: " debug " },
        instances: [
            {
                name: " local-one ",
                provider: " local ",
                workspace: " /workspace "
            }
        ],
        mcp: {
            auth: {
                mode: " oauth2 ",
                oauth2: {
                    requiredScopes: [" mcp ", " artifacts "],
                    resourceName: " aromatic "
                }
            }
        }
    });

    assert.equal(parsed.control?.logLevel, "debug");
    assert.equal(parsed.instances?.[0]?.name, "local-one");
    assert.equal(parsed.instances?.[0]?.provider, "local");
    assert.equal(parsed.instances?.[0]?.workspace, "/workspace");
    assert.deepEqual(parsed.mcp?.auth, {
        mode: "oauth2",
        oauth2: {
            audience: undefined,
            documentationUrl: undefined,
            issuer: undefined,
            jwksUri: undefined,
            requiredScopes: ["mcp", "artifacts"],
            resourceName: "aromatic"
        }
    });

    const patch = parseConfigInstancePatch({
        container: null,
        env: null,
        ssh: null,
        tools: null
    });
    assert.deepEqual(patch, {
        approvalPolicy: undefined,
        container: null,
        dockerBinary: undefined,
        enabled: undefined,
        env: null,
        logs: undefined,
        mcp: undefined,
        podmanBinary: undefined,
        provider: undefined,
        security: undefined,
        ssh: null,
        tools: null,
        workspace: undefined
    });
});

test("config parser rejects unknown fields and invalid OAuth2 structure with exact paths", () => {
    assertConfigIssue(
        () =>
            parseConfigDraft({
                instances: [
                    {
                        legacyField: true,
                        name: "local-one",
                        provider: "local",
                        workspace: "/workspace"
                    }
                ]
            }),
        "parse",
        ["instances", 0, "legacyField"],
        "config.field.unknown"
    );
    assertConfigIssue(
        () => parseConfigDraft({ mcp: { auth: { mode: "oauth2" } } }),
        "parse",
        ["mcp", "auth", "oauth2"],
        "config.auth.oauth2Required"
    );
    assertConfigIssue(
        () =>
            parseConfigDraft({
                mcp: {
                    auth: {
                        mode: "token",
                        oauth2: { resourceName: "unexpected" }
                    }
                }
            }),
        "parse",
        ["mcp", "auth", "oauth2"],
        "config.auth.unexpectedOauth2"
    );
});

test("config normalization applies provider defaults and deduplicates MCP access lists", () => {
    const config = normalizeConfigDraft({
        instances: [
            {
                container: {
                    mode: "preset",
                    preset: "arch"
                },
                mcp: {
                    tools: {
                        capabilities: ["read", "read", "execute"],
                        groups: ["file", "file", "bash"]
                    }
                },
                name: "docker-one",
                provider: "docker",
                workspace: "/workspace"
            }
        ]
    });

    assert.equal(config.control.logLevel, "info");
    assert.equal(config.mcp.listenHost, "127.0.0.1");
    assert.equal(config.mcp.listenPort, 17890);
    assert.equal(config.instances[0]?.enabled, true);
    assert.equal(config.instances[0]?.security.mode, "disabled");
    assert.equal(config.instances[0]?.mcp.path, "/docker-one/mcp");
    assert.deepEqual(config.instances[0]?.mcp.tools.capabilities, ["read", "execute"]);
    assert.deepEqual(config.instances[0]?.mcp.tools.groups, ["file", "bash"]);
    assert.deepEqual(config.instances[0]?.container, {
        containerName: "devshell-docker-one",
        env: undefined,
        image: "archlinux:latest",
        mode: "preset",
        mounts: undefined,
        network: undefined,
        preset: "arch",
        user: undefined
    });
});

test("provider changes discard stale provider-specific fields before normalization", () => {
    const current = normalizeConfigInstanceDraft({
        name: "remote-one",
        provider: "ssh",
        ssh: { command: "ssh remote" },
        workspace: "/workspace"
    });
    const draft = applyConfigInstancePatch(current, {
        container: { mode: "preset", preset: "debian" },
        provider: "docker"
    });

    assert.equal(draft.provider, "docker");
    assert.equal(draft.ssh, undefined);
    assert.equal(draft.dockerBinary, undefined);
    assert.deepEqual(draft.container, { mode: "preset", preset: "debian" });

    const normalized = normalizeConfigInstanceDraft(draft);
    assert.equal(normalized.provider, "docker");
    assert.equal(normalized.container.mode, "preset");
});

test("semantic validation rejects duplicate names and mismatched instance MCP paths", () => {
    const duplicate = normalizeConfigDraft({
        instances: [
            { name: "local-one", provider: "local", workspace: "/one" },
            { name: "local-one", provider: "local", workspace: "/two" }
        ]
    });
    assertConfigIssue(
        () => validateConfigSemantics(duplicate),
        "semantic",
        ["instances", 1, "name"],
        "config.instance.duplicateName"
    );

    const wrongPath = normalizeConfigDraft({
        instances: [{ name: "local-one", provider: "local", workspace: "/one" }]
    });
    wrongPath.instances[0]!.mcp.path = "/wrong/mcp";
    assertConfigIssue(
        () => validateConfigSemantics(wrongPath),
        "semantic",
        ["instances", 0, "mcp", "path"],
        "config.instance.mcpPath"
    );
});

test("semantic validation requires authenticated public MCP and a public reverse endpoint", () => {
    const publicWithoutAuth = normalizeConfigDraft({
        instances: [],
        mcp: {
            auth: { mode: "none" },
            enabled: true,
            listenHost: "0.0.0.0",
            publicBaseUrl: "https://devshell.example"
        }
    });
    assertConfigIssue(
        () => validateConfigSemantics(publicWithoutAuth),
        "semantic",
        ["mcp", "auth", "mode"],
        "config.mcp.publicAuthRequired"
    );

    const reverseWithoutMcp = normalizeConfigDraft({
        instances: [{ name: "reverse-one", provider: "reverse", workspace: "/workspace" }],
        mcp: { enabled: false, publicBaseUrl: null }
    });
    assertConfigIssue(
        () => validateConfigSemantics(reverseWithoutMcp),
        "semantic",
        ["mcp", "enabled"],
        "config.reverse.mcpRequired"
    );

    const reverseWithoutPublicBaseUrl = normalizeConfigDraft({
        instances: [{ name: "reverse-one", provider: "reverse", workspace: "/workspace" }],
        mcp: { auth: { mode: "token" }, enabled: true, publicBaseUrl: null }
    });
    assertConfigIssue(
        () => validateConfigSemantics(reverseWithoutPublicBaseUrl),
        "semantic",
        ["mcp", "publicBaseUrl"],
        "config.reverse.publicBaseUrlRequired"
    );
});

function assertConfigIssue(
    action: () => unknown,
    phase: "normalize" | "parse" | "semantic",
    path: readonly (number | string)[],
    code: string
): void {
    assert.throws(action, (error: unknown) => {
        assert.ok(error instanceof ConfigInputError);
        assert.equal(error.issue.phase, phase);
        assert.deepEqual(error.issue.path, path);
        assert.equal(error.issue.code, code);
        return true;
    });
}
