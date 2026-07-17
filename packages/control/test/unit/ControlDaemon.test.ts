import assert from "node:assert/strict";
import test from "node:test";

import { ControlDaemon } from "../../dist/testing.js";

test("a stopping daemon preserves successor lifecycle state", async () => {
    const lifecycle = { pid: "old", socket: "old" };
    const daemon = new ControlDaemon({
        logger: {
            async info() {},
            path: "/tmp/control.log"
        } as never,
        pidFile: {
            async write() {
                lifecycle.pid = "old";
            }
        } as never,
        server: {
            async start() {},
            async stop() {}
        } as never,
        socketFile: {
            async ensureRuntimeDir() {}
        } as never
    });

    await daemon.start();
    lifecycle.pid = "new";
    lifecycle.socket = "new";

    await daemon.stop();

    assert.deepEqual(lifecycle, { pid: "new", socket: "new" });
});
