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
        mcp: {
            enabled: true
        },
        web: {
            auth: "none",
            enabled: true,
            listenHost: " 192.168.1.5 ",
            listenPort: 17891,
            publicBaseUrl: " 192.168.1.5 "
        },
        instances: [
            {
                mcp: {
                    auth: " oauth2 ",
                    oauth2: {
                        requiredScopes: [" mcp ", " artifacts "],
                        resourceName: " aromatic "
                    }
                },
                name: "local-one",
                provider: "local",
                workspace: "/workspace"
            }
        ]
    });

    assert.equal(parsed.control?.logLevel, "debug");
    assert.equal(parsed.instances?.[0]?.name, "local-one");
    assert.equal(parsed.instances?.[0]?.provider, "local");
    assert.equal(parsed.instances?.[0]?.workspace, "/workspace");
    assert.equal(parsed.mcp?.enabled, true);
    assert.equal(parsed.instances?.[0]?.mcp?.auth, "oauth2");
    assert.deepEqual(parsed.instances?.[0]?.mcp?.oauth2, {
            documentationUrl: undefined,
            requiredScopes: ["mcp", "artifacts"],
            resourceName: "aromatic"
    });
    assert.equal(parsed.web?.enabled, true);
    assert.equal(parsed.web?.listenHost, "192.168.1.5");
    assert.equal(parsed.web?.publicBaseUrl, "192.168.1.5");

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

test("top-level MCP rejects auth while instance MCP validates OAuth2 structure", () => {
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
        ["mcp", "auth"],
        "config.field.unknown"
    );
    assertConfigIssue(
        () =>
            parseConfigDraft({
                instances: [{
                    mcp: { auth: "token", oauth2: { resourceName: "unexpected" } },
                    name: "local-one",
                    provider: "local",
                    workspace: "/workspace"
                }]
            }),
        "parse",
        ["instances", 0, "mcp", "oauth2"],
        "config.auth.unexpectedOauth2"
    );
    assertConfigIssue(
        () => parseConfigDraft({ instances: [{ mcp: { auth: "token" }, name: "local-one", provider: "local", workspace: "/workspace" }] }),
        "parse",
        ["instances", 0, "mcp", "token"],
        "config.auth.tokenRequired"
    );
    assertConfigIssue(
        () =>
            parseConfigDraft({
                instances: [{
                    mcp: {
                        auth: "oauth2",
                        oauth2: {
                            issuer: "https://issuer.example",
                            resourceName: "aromatic"
                        }
                    },
                    name: "local-one",
                    provider: "local",
                    workspace: "/workspace"
                }]
            }),
        "parse",
        ["instances", 0, "mcp", "oauth2", "issuer"],
        "config.field.unknown"
    );
});

test("instance token auth requires a non-trivial configured secret", () => {
    const token = "0123456789abcdef0123456789abcdef";
    assert.deepEqual(
        normalizeConfigDraft({ instances: [{ mcp: { auth: "token", token }, name: "local-one", provider: "local", workspace: "/workspace" }] }).instances[0]!.mcp.auth,
        { mode: "token", token }
    );

    const weak = normalizeConfigDraft({
        instances: [{ mcp: { auth: "token", token: "too-short" }, name: "local-one", provider: "local", workspace: "/workspace" }]
    });
    assertConfigIssue(
        () => validateConfigSemantics(weak),
        "semantic",
        ["instances", 0, "mcp", "auth", "token"],
        "config.auth.tokenWeak"
    );
});

test("config normalization deduplicates MCP access lists", () => {
    const config = normalizeConfigDraft({
        instances: [
            {
                mcp: {
                    tools: {
                        capabilities: ["read", "read", "execute"],
                        groups: ["file", "file", "bash"]
                    }
                },
                name: "local-one",
                provider: "local",
                workspace: "/workspace"
            }
        ]
    });

    assert.deepEqual(config.instances[0]?.mcp.tools.capabilities, ["read", "execute"]);
    assert.deepEqual(config.instances[0]?.mcp.tools.groups, ["file", "bash"]);
});

test("obsolete context groups are removed from custom MCP allowlists", () => {
    const custom = normalizeConfigInstanceDraft({
        mcp: { tools: { groups: ["file", "bash", "context", "todo"] } },
        name: "custom-policy",
        provider: "local",
        workspace: "/workspace"
    });

    assert.deepEqual(custom.mcp.tools.groups, ["file", "bash", "todo"]);
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

test("semantic validation permits explicitly exposed unauthenticated endpoints and validates reverse endpoints", () => {
    const publicWithoutAuth = normalizeConfigDraft({
        instances: [],
        mcp: {
            enabled: true,
            listenHost: "0.0.0.0",
            publicBaseUrl: "https://devshell.example"
        }
    });
    assert.doesNotThrow(() => validateConfigSemantics(publicWithoutAuth));

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
