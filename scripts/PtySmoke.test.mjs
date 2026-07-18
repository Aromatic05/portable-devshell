import assert from "node:assert/strict";
import test from "node:test";

import { waitForPtyMarker } from "./PtySmoke.mjs";

function createFakePty() {
    let dataListener;
    let exitListener;
    let killed = false;
    return {
        emitData(value) {
            dataListener?.(value);
        },
        emitExit(exitCode) {
            exitListener?.({ exitCode });
        },
        get killed() {
            return killed;
        },
        kill() {
            killed = true;
        },
        onData(listener) {
            dataListener = listener;
            return { dispose() { dataListener = undefined; } };
        },
        onExit(listener) {
            exitListener = listener;
            return { dispose() { exitListener = undefined; } };
        }
    };
}

test("PTY smoke resolves as soon as the marker is observed and releases the PTY", async () => {
    const pty = createFakePty();
    const pending = waitForPtyMarker(pty, "ready", 1_000);
    pty.emitData("re");
    pty.emitData("ady");

    assert.equal(await pending, "ready");
    assert.equal(pty.killed, true);
});

test("PTY smoke rejects an exit without the marker", async () => {
    const pty = createFakePty();
    const pending = waitForPtyMarker(pty, "ready", 1_000);
    pty.emitExit(0);

    await assert.rejects(pending, /node-pty smoke failed/u);
    assert.equal(pty.killed, true);
});

test("PTY smoke times out and releases a stuck PTY", async () => {
    const pty = createFakePty();

    await assert.rejects(waitForPtyMarker(pty, "ready", 5), /timed out/u);
    assert.equal(pty.killed, true);
});
