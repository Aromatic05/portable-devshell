import assert from "node:assert/strict";
import test from "node:test";

import type { JsonValue } from "@portable-devshell/shared";

import { TuiAppStore } from "../../src/state/TuiAppStore.ts";
import { buildConnectorPageBoxes } from "../../src/view/page/TuiPageConnector.ts";

function expandedWebBox(webDraft: Record<string, JsonValue>) {
    const store = new TuiAppStore();
    store.setSelectedPage("connections");
    store.setSelectedInstance("alpha");
    store.patchControlReadModel({ configView: {
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
    } });
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
