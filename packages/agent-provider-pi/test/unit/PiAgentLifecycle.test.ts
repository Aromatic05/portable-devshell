import assert from "node:assert/strict";
import test from "node:test";

import { disposeManagedPiAgent } from "../../src/PiAgentLifecycle.ts";
import type { PiSessionLike } from "../../src/PiSdkLoader.ts";

function fakeSession(events: string[], abortError?: Error): PiSessionLike {
    return {
        sessionId: "session-1",
        async abort() {
            events.push("abort");
            if (abortError !== undefined) throw abortError;
        },
        dispose() {
            events.push("dispose");
        },
        async followUp() {},
        async prompt() {},
        async reload() {}
    };
}

test("managed Pi Agent disposal aborts, detaches, and disposes its session", async () => {
    const events: string[] = [];
    const session = fakeSession(events);

    await disposeManagedPiAgent(
        { session },
        { detach(value) {
            assert.equal(value, session);
            events.push("detach");
        } }
    );

    assert.deepEqual(events, ["abort", "detach", "dispose"]);
});

test("managed Pi Agent disposal continues after an abort failure", async () => {
    const events: string[] = [];
    const session = fakeSession(events, new Error("already stopped"));

    await disposeManagedPiAgent(
        { session },
        { detach() {
            events.push("detach");
        } }
    );

    assert.deepEqual(events, ["abort", "detach", "dispose"]);
});
