import assert from "node:assert/strict";
import test from "node:test";

import {
    applyConfigWebPatch,
    createDefaultControlConfig,
    normalizeConfigGlobalDraft,
    parseConfigGlobalDraft,
    validateConfigSemantics
} from "@portable-devshell/shared";

const strongToken = "a".repeat(48);

test("web auth defaults to none without residual fields", () => {
    const global = normalizeConfigGlobalDraft(parseConfigGlobalDraft({ web: { enabled: true } }));
    assert.deepEqual(global.web.auth, { mode: "none" });
});

test("web token mode normalizes into a structured auth config", () => {
    const global = normalizeConfigGlobalDraft(
        parseConfigGlobalDraft({ web: { auth: "token", token: ` ${strongToken} ` } })
    );
    assert.deepEqual(global.web.auth, { mode: "token", token: strongToken });
});

test("web oauth2 mode normalizes scopes and preserves resource metadata", () => {
    const global = normalizeConfigGlobalDraft(
        parseConfigGlobalDraft({
            web: {
                auth: "oauth2",
                oauth2: {
                    documentationUrl: "https://docs.example.com/web",
                    requiredScopes: [" web ", "admin", "web"],
                    resourceName: " aromatic-web "
                }
            }
        })
    );
    assert.deepEqual(global.web.auth, {
        mode: "oauth2",
        oauth2: {
            documentationUrl: "https://docs.example.com/web",
            requiredScopes: ["web", "admin"],
            resourceName: "aromatic-web"
        }
    });
});

test("web auth=none rejects residual token and oauth2 fields", () => {
    assert.throws(
        () => parseConfigGlobalDraft({ web: { auth: "none", token: strongToken } }),
        /must not configure oauth2 or token when auth=none/u
    );
    assert.throws(
        () =>
            parseConfigGlobalDraft({
                web: { auth: "none", oauth2: { resourceName: "web" } }
            }),
        /must not configure oauth2 or token when auth=none/u
    );
});

test("web auth=token requires a token and rejects oauth2 residual", () => {
    assert.throws(() => parseConfigGlobalDraft({ web: { auth: "token" } }), /token.*is required when auth=token/u);
    assert.throws(
        () =>
            parseConfigGlobalDraft({
                web: { auth: "token", oauth2: { resourceName: "web" }, token: strongToken }
            }),
        /must be omitted when auth=token/u
    );
});

test("web auth=oauth2 requires an oauth2 block and rejects token residual", () => {
    assert.throws(() => parseConfigGlobalDraft({ web: { auth: "oauth2" } }), /oauth2.*is required when auth=oauth2/u);
    assert.throws(
        () =>
            parseConfigGlobalDraft({
                web: { auth: "oauth2", oauth2: { resourceName: "web" }, token: strongToken }
            }),
        /must be omitted when auth=oauth2/u
    );
});

test("web oauth2 or token configuration without auth mode is rejected", () => {
    assert.throws(
        () => parseConfigGlobalDraft({ web: { token: strongToken } }),
        /auth.*is required when configuring oauth2 or token/u
    );
});

test("web oauth2 block rejects unknown residual fields", () => {
    assert.throws(
        () =>
            parseConfigGlobalDraft({
                web: { auth: "oauth2", oauth2: { clientSecret: "x", resourceName: "web" } }
            }),
        /clientSecret is not supported/u
    );
});

test("semantic validation rejects a weak web token", () => {
    const config = createDefaultControlConfig();
    config.web.auth = { mode: "token", token: "short" };
    assert.throws(() => validateConfigSemantics(config), /at least 32 UTF-8 bytes/u);
});

test("semantic validation accepts a strong web token", () => {
    const config = createDefaultControlConfig();
    config.web.auth = { mode: "token", token: strongToken };
    assert.equal(validateConfigSemantics(config), config);
});

test("semantic validation rejects an invalid oauth2 documentation url", () => {
    const config = createDefaultControlConfig();
    config.web.auth = {
        mode: "oauth2",
        oauth2: { documentationUrl: "not a url", requiredScopes: [], resourceName: "web" }
    };
    assert.throws(() => validateConfigSemantics(config), /must be a valid URL/u);
});

test("web auth patch switches mode and drops stale residual fields", () => {
    const config = createDefaultControlConfig();
    config.web.auth = { mode: "token", token: strongToken };

    const toOauth2 = applyConfigWebPatch(config.web, {
        auth: "oauth2",
        oauth2: { requiredScopes: ["web"], resourceName: "web" }
    });
    assert.equal(toOauth2?.auth, "oauth2");
    assert.equal(toOauth2?.token, undefined);
    assert.deepEqual(toOauth2?.oauth2, {
        documentationUrl: undefined,
        requiredScopes: ["web"],
        resourceName: "web"
    });

    const toNone = applyConfigWebPatch(config.web, { auth: "none" });
    assert.equal(toNone?.auth, "none");
    assert.equal(toNone?.token, undefined);
    assert.equal(toNone?.oauth2, undefined);
});
