import assert from "node:assert/strict";
import test from "node:test";
import { CliRenderError } from "../../src/app/Failure.js";
import { executeControlLifecycle } from "../../src/command/control/server/Lifecycle.js";

test("restart of incompatible running Control offers recovery without stopping services", async () => {
    const calls: string[] = [];
    await assert.rejects(executeControlLifecycle({ kind: "control.restart" }, {
        controlNegotiated: false,
        async lifecycle() { return {
            async status() { calls.push("status"); return { running: true }; },
            async stop() { calls.push("stop"); },
            async start() { calls.push("start"); },
        }; },
        async negotiate() { throw new CliRenderError("control.protocolVersionMismatch", "Incompatible control protocol version: 0."); },
    } as never), (error: unknown) => {
        assert.ok(error instanceof CliRenderError);
        assert.equal(error.code, "control.protocolVersionMismatch");
        assert.match(error.message, /devshell stop/u);
        assert.match(error.message, /devshell start/u);
        assert.match(error.message, /devshell instance start <name>/u);
        assert.match(error.message, /Manual stop interrupts running Instances/u);
        return true;
    });
    assert.deepEqual(calls, ["status"]);
});

test("restart preserves unrelated negotiation failures", async () => {
    const failure = new Error("socket unavailable");
    await assert.rejects(executeControlLifecycle({ kind: "control.restart" }, {
        controlNegotiated: false,
        async lifecycle() { return { async status() { return { running: true }; } }; },
        async negotiate() { throw failure; },
    } as never), (error) => error === failure);
});
