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
        control: { artifactDirectTransfer: true, logLevel: " debug " },
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
                provider: "local"
            }
        ]
    });

    assert.equal(parsed.control?.artifactDirectTransfer, true);
    assert.equal(parsed.control?.logLevel, "debug");
    assert.equal(parsed.instances?.[0]?.name, "local-one");
    assert.equal(parsed.instances?.[0]?.provider, "local");
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
        alerts: undefined,
        approvalPolicy: undefined,
        container: null,
        dockerBinary: undefined,
        enabled: undefined,
        env: null,
        extensions: undefined,
        logs: undefined,
        mcp: undefined,
        podmanBinary: undefined,
        provider: undefined,
        security: undefined,
        ssh: null,
        tools: null
    });
});

test("instance MCP context mode defaults to explicit and accepts openai-session", () => {
    const explicit = normalizeConfigInstanceDraft({ name: "explicit", provider: "local" });
    assert.equal(explicit.mcp.contextMode, "explicit");

    const parsed = parseConfigDraft({
        instances: [{
            mcp: { contextMode: "openai-session" },
            name: "chatgpt",
            provider: "local"
        }]
    });
    assert.equal(parsed.instances?.[0]?.mcp?.contextMode, "openai-session");
    assert.equal(normalizeConfigDraft(parsed).instances[0]?.mcp.contextMode, "openai-session");

    const patched = applyConfigInstancePatch(explicit, { mcp: { contextMode: "openai-session" } });
    assert.equal(normalizeConfigInstanceDraft(patched).mcp.contextMode, "openai-session");
});

test("instance configuration has no persistent workspace authority", () => {
    const instance = normalizeConfigInstanceDraft({
        name: "local-one",
        provider: "local"
    });

    assert.equal("workspace" in instance, false);
    assertConfigIssue(
        () => parseConfigDraft({
            instances: [{
                name: "legacy-workspace",
                provider: "local",
                workspace: "/workspace"
            }]
        }),
        "parse",
        ["instances", 0, "workspace"],
        "config.field.unknown"
    );
});

test("top-level MCP rejects auth while instance MCP validates OAuth2 structure", () => {
    assertConfigIssue(
        () =>
            parseConfigDraft({
                instances: [
                    {
                        legacyField: true,
                        name: "local-one",
                        provider: "local"
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
                    provider: "local"
                }]
            }),
        "parse",
        ["instances", 0, "mcp", "oauth2"],
        "config.auth.unexpectedOauth2"
    );
    assertConfigIssue(
        () => parseConfigDraft({ instances: [{ mcp: { auth: "token" }, name: "local-one", provider: "local" }] }),
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
                    provider: "local"
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
        normalizeConfigDraft({ instances: [{ mcp: { auth: "token", token }, name: "local-one", provider: "local" }] }).instances[0]!.mcp.auth,
        { mode: "token", token }
    );

    const weak = normalizeConfigDraft({
        instances: [{ mcp: { auth: "token", token: "too-short" }, name: "local-one", provider: "local" }]
    });
    assertConfigIssue(
        () => validateConfigSemantics(weak),
        "semantic",
        ["instances", 0, "mcp", "auth", "token"],
        "config.auth.tokenWeak"
    );
});

test("openai-session context mode rejects custom token authentication", () => {
    const token = "0123456789abcdef0123456789abcdef";
    const config = normalizeConfigDraft({
        instances: [{
            mcp: { auth: "token", contextMode: "openai-session", token },
            name: "chatgpt-one",
            provider: "local"
        }]
    });
    assertConfigIssue(
        () => validateConfigSemantics(config),
        "semantic",
        ["instances", 0, "mcp", "contextMode"],
        "config.instance.mcpContextAuth"
    );

    assert.doesNotThrow(() => validateConfigSemantics(normalizeConfigDraft({
        instances: [{
            mcp: { auth: "none", contextMode: "openai-session" },
            name: "chatgpt-none",
            provider: "local"
        }]
    })));
});

test("config normalization deduplicates model Extension allowlists", () => {
    const config = normalizeConfigDraft({
        instances: [
            {
                extensions: { model: ["instance", "instance", "artifact"] },
                name: "local-one",
                provider: "local"
            }
        ]
    });

    assert.deepEqual(config.instances[0]?.extensions.model, ["instance", "artifact"]);
});

test("model Extension allowlist defaults to the conservative Instance surface", () => {
    const normalized = normalizeConfigInstanceDraft({
        name: "default-model-extensions",
        provider: "local"
    });
    assert.deepEqual(normalized.extensions.model, ["instance"]);
});

test("explicit empty model Extension allowlist disables all model commands", () => {
    const normalized = normalizeConfigInstanceDraft({
        extensions: { model: [] },
        name: "model-disabled",
        provider: "local"
    });
    assert.deepEqual(normalized.extensions.model, []);
});

test("instance config rejects the retired mcp.tools policy field", () => {
    assert.throws(
        () => parseConfigDraft({
            instances: [{
                mcp: { tools: { groups: ["file"] } },
                name: "legacy-policy",
                provider: "local"
            }]
        }),
        /mcp\.tools is not supported/u
    );
});

test("config rejects invalid model Extension ids", () => {
    const normalized = normalizeConfigDraft({
        instances: [{
            extensions: { model: ["instance", "bad_extension"] },
            name: "bad-extension",
            provider: "local"
        }]
    });

    assert.throws(
        () => validateConfigSemantics(normalized),
        /\[a-z\]\[a-z0-9-\]\*/u,
    );
});

test("provider changes discard stale provider-specific fields before normalization", () => {
    const current = normalizeConfigInstanceDraft({
        name: "remote-one",
        provider: "ssh",
        ssh: { command: "ssh remote" }
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
            { name: "local-one", provider: "local" },
            { name: "local-one", provider: "local" }
        ]
    });
    assertConfigIssue(
        () => validateConfigSemantics(duplicate),
        "semantic",
        ["instances", 1, "name"],
        "config.instance.duplicateName"
    );

    const wrongPath = normalizeConfigDraft({
        instances: [{ name: "local-one", provider: "local" }]
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
        instances: [{ name: "reverse-one", provider: "reverse" }],
        mcp: { enabled: false, publicBaseUrl: null }
    });
    assertConfigIssue(
        () => validateConfigSemantics(reverseWithoutMcp),
        "semantic",
        ["mcp", "enabled"],
        "config.reverse.mcpRequired"
    );

    const reverseWithoutPublicBaseUrl = normalizeConfigDraft({
        instances: [{ name: "reverse-one", provider: "reverse" }],
        mcp: { enabled: true, publicBaseUrl: null }
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
