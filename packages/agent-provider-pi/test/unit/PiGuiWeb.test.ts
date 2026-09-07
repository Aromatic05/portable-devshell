import assert from "node:assert/strict";
import test from "node:test";

import {
    PiGuiWeb,
    isManagedPiGuiRequest,
    rewritePiGuiAsset
} from "../../src/PiGuiWeb.ts";

test("Pi GUI asset rebasing follows the current forwarded Agent mount path", async (t) => {
    const gui = await PiGuiWeb.start("/old/web/agent/");
    t.after(async () => await gui.stop());

    const response = await fetch(gui.upstream, {
        headers: { "x-forwarded-prefix": "/new/web/agent" }
    });
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.doesNotMatch(body, /\/old\/web\/agent\/assets\//u);
    assert.match(body, /\/new\/web\/agent\/assets\//u);
});

test("Pi GUI assets are rebased under the single Agent path", () => {
    const source = [
        '<script src="/assets/index.js"></script>',
        'fetch(`/api/sessions/${id}/messages`)',
        'const icon="/favicon.svg";',
        'var preload=function(e){return`/`+e}'
    ].join("\n");

    const rewritten = rewritePiGuiAsset(source, "/web/agent/");

    assert.match(rewritten, /src="\/web\/agent\/assets\/index\.js"/u);
    assert.match(rewritten, /fetch\(`\/web\/agent\/api\/sessions/u);
    assert.match(rewritten, /"\/web\/agent\/favicon\.svg"/u);
    assert.match(rewritten, /return`\/web\/agent\/`\+e/u);
});

test("Pi GUI exposes managed live-session controls but blocks local runtime escape hatches", () => {
    for (const [method, path] of [
        ["GET", "/"],
        ["GET", "/assets/index.js"],
        ["GET", "/api/sessions"],
        ["GET", "/api/sessions/session-1/messages"],
        ["GET", "/api/sessions/session-1/events"],
        ["POST", "/api/sessions/session-1/prompt"],
        ["POST", "/api/sessions/session-1/steer"],
        ["POST", "/api/sessions/session-1/abort"],
        ["PATCH", "/api/sessions/session-1"]
    ] as const) {
        assert.equal(isManagedPiGuiRequest(method, path), true, `${method} ${path}`);
    }

    for (const [method, path] of [
        ["POST", "/api/sessions"],
        ["GET", "/api/fs"],
        ["POST", "/api/shutdown"],
        ["POST", "/api/sessions/session-1/bash"],
        ["POST", "/api/sessions/session-1/fork"],
        ["POST", "/api/sessions/session-1/share"],
        ["GET", "/api/sessions/session-1/git"],
        ["POST", "/api/sessions/session-1/skills"],
        ["DELETE", "/api/sessions/session-1"]
    ] as const) {
        assert.equal(isManagedPiGuiRequest(method, path), false, `${method} ${path}`);
    }
});
