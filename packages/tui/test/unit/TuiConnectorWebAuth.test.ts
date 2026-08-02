import assert from "node:assert/strict";
import test from "node:test";

import type { JsonValue } from "@portable-devshell/shared";

import { TuiAppStore } from "../../src/state/TuiAppStore.ts";
import { buildConnectorPageBoxes } from "../../src/view/page/TuiPageConnector.ts";

function expandedWebBox(webDraft: Record<string, JsonValue>) {
    const store = new TuiAppStore();
    store.setSelectedPage("connections");
    store.setSelectedInstance("alpha");
    store.setConfigView({
        control: {},
        instances: [
            {
                enabled: true,
                mcp: { auth: "none", enabled: true, path: "/alpha/mcp" },
                name: "alpha",
                provider: "local",
                security: { effectiveMode: "disabled", mode: "disabled" },
                workspace: "/workspace/alpha",
            },
        ],
        mcp: {
            enabled: true,
            listenHost: "127.0.0.1",
            listenPort: 3210,
            publicBaseUrl: "http://127.0.0.1:3210",
        },
        web: webDraft,
    });
    store.setFormDraft("web", webDraft, true);

    const collapsed = buildConnectorPageBoxes(store.getState(), "alpha").find(
        (box) => box.id === "web",
    );
    assert.ok(collapsed);
    store.toggleExpanded(collapsed.expandedKey);

    const expanded = buildConnectorPageBoxes(store.getState(), "alpha").find(
        (box) => box.id === "web",
    );
    assert.ok(expanded?.expanded);
    return expanded;
}

test("Web token authentication exposes an editable secret before save", () => {
    const web = expandedWebBox({
        auth: "token",
        enabled: true,
        listenHost: "127.0.0.1",
        listenPort: 3211,
        publicBaseUrl: "http://127.0.0.1:3211",
        token: "new-secret-token",
    });

    const token = web.expandedLines.find((line) => line.id === "web:field:web.token");
    assert.ok(token);
    assert.match(token.text, /secret/u);
    assert.equal(token.text.includes("new-secret-token"), false);
});

test("Web OAuth authentication exposes every required provider field before save", () => {
    const web = expandedWebBox({
        auth: "oauth2",
        enabled: true,
        listenHost: "127.0.0.1",
        listenPort: 3211,
        oauth2: {
            documentationUrl: "https://docs.example.test/web",
            requiredScopes: ["web", "profile"],
            resourceName: "portable-devshell-web",
        },
        publicBaseUrl: "https://example.test/web",
    });

    const fieldIds = new Set(web.expandedLines.map((line) => line.id));
    assert.equal(fieldIds.has("web:field:web.oauth2.resourceName"), true);
    assert.equal(fieldIds.has("web:field:web.oauth2.requiredScopes"), true);
    assert.equal(fieldIds.has("web:field:web.oauth2.documentationUrl"), true);
});
