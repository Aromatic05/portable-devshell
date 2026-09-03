import assert from "node:assert/strict";
import test from "node:test";

import type { DevshellPiWorkspaceBridge } from "@portable-devshell/pi-extension";

import { disposeManagedPiAgent } from "../../src/provider/pi/PiAgentLifecycle.ts";
import type { PiSessionLike } from "../../src/provider/pi/PiSdkLoader.ts";

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
        async prompt() {}
    };
}

function fakeBridge(events: string[]): DevshellPiWorkspaceBridge {
    return {
        async close() {
            events.push("close");
        },
        async extension() {},
        async loadContextFiles() {
            return [];
        }
    };
}

test("managed Pi Agent disposal owns and closes its devshell workspace bridge", async () => {
    const events: string[] = [];
    const session = fakeSession(events);

    await disposeManagedPiAgent(
        { devshell: fakeBridge(events), session },
        { detach(value) {
            assert.equal(value, session);
            events.push("detach");
        } }
    );

    assert.deepEqual(events, ["abort", "detach", "dispose", "close"]);
});

test("managed Pi Agent disposal still closes its bridge after an abort failure", async () => {
    const events: string[] = [];
    const session = fakeSession(events, new Error("already stopped"));

    await disposeManagedPiAgent(
        { devshell: fakeBridge(events), session },
        { detach() {
            events.push("detach");
        } }
    );

    assert.deepEqual(events, ["abort", "detach", "dispose", "close"]);
});
