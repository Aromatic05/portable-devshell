import assert from "node:assert/strict";
import test from "node:test";

import {
    PiGuiWeb,
    isManagedPiGuiRequest,
} from "../../src/provider/pi/render/GuiWeb.ts";

test("Pi GUI asset rebasing follows the current forwarded Agent mount path", async (t) => {
    const gui = await PiGuiWeb.start("/old/web/agent/");
    t.after(async () => await gui.stop());

    const response = await fetch(gui.upstream, {
        headers: { "x-forwarded-prefix": "/new/web/agent" },
    });
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.doesNotMatch(body, /\/old\/web\/agent\/assets\//u);
    assert.match(body, /\/new\/web\/agent\/assets\//u);
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
        ["PATCH", "/api/sessions/session-1"],
    ] as const) {
        assert.equal(
            isManagedPiGuiRequest(method, path),
            true,
            `${method} ${path}`,
        );
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
        ["DELETE", "/api/sessions/session-1"],
    ] as const) {
        assert.equal(
            isManagedPiGuiRequest(method, path),
            false,
            `${method} ${path}`,
        );
    }
});
