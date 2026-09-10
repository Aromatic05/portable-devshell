import assert from "node:assert/strict";
import test from "node:test";

import { TuiAppStore } from "../../src/state/TuiAppStore.js";
import { isActiveContextForInstance } from "../../src/state/audit/TuiAuditContextActivity.js";

test("Context activity authority follows registry status and instance binding", () => {
    const store = new TuiAppStore();
    store.patchControlReadModel({
        contexts: [
            context("ctx-active", "active", "alpha"),
            context("ctx-disabled", "disabled", "alpha"),
            context("ctx-other-instance", "active", "beta"),
        ],
    });

    assert.equal(isActiveContextForInstance(store.getState(), "alpha", "ctx-active"), true);
    assert.equal(isActiveContextForInstance(store.getState(), "alpha", "ctx-disabled"), false);
    assert.equal(isActiveContextForInstance(store.getState(), "alpha", "ctx-other-instance"), false);
});

function context(
    ctxId: string,
    status: "active" | "disabled",
    instance: string,
) {
    return {
        createdAt: "2026-08-07T00:00:00.000Z",
        ctxId,
        environments: [{ instance, workspace: `/workspace/${ctxId}` }],
        expiresAt: "2099-08-07T00:00:00.000Z",
        instance,
        lastAccessedAt: "2026-08-07T00:05:00.000Z",
        principal: "test",
        status,
        workspace: `/workspace/${ctxId}`,
    };
}
