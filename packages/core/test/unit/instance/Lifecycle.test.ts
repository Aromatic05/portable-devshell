import assert from "node:assert/strict";
import test from "node:test";

import { runtimeErrorCodes } from "@portable-devshell/shared";

import { Instance } from "../../../src/instance/Instance.ts";
import { ReverseExecution } from "../../../src/instance/runtime/execution/provider/Reverse.ts";

test("self-managed worker execution rejects Control start and stop", async () => {
    const execution = new ReverseExecution({
        applyStateUpdate: async () => ({}) as never,
        connection: {} as never,
        name: "reverse-mac",
    });

    for (const operation of [() => execution.start(), () => execution.stop()]) {
        assert.throws(operation, (error: unknown) => {
            assert.equal(
                (error as { code?: string }).code,
                runtimeErrorCodes.reverseSelfManagedLifecycle,
            );
            assert.match(
                (error as Error).message,
                /self-managed.*remote machine/iu,
            );
            return true;
        });
    }
});

test("instance retirement fences synchronously and invokes beforeDrain once", async () => {
    const instance = new Instance({
        enabled: true,
        mcpEnabled: false,
        mcpPath: "/reverse-mac/mcp",
        modelExtensions: [],
        name: "reverse-mac",
        provider: "local",
        worker: {} as never,
    });
    let callbacks = 0;
    let reentrantRetirement: Promise<void> | undefined;
    const retirement = instance.retire(async () => {
        callbacks += 1;
        reentrantRetirement = instance.retire(async () => {
            callbacks += 1;
        });
    });

    assert.equal(instance.retired, true);
    await retirement;

    assert.equal(callbacks, 1);
    assert.strictEqual(reentrantRetirement, retirement);
});

test("failed instance retirement can be retried without reopening admission", async () => {
    const instance = new Instance({
        enabled: true,
        mcpEnabled: false,
        mcpPath: "/retry/mcp",
        modelExtensions: [],
        name: "retry",
        provider: "local",
        worker: {} as never,
    });
    const failure = new Error("approval retirement failed once");
    let calls = 0;
    const failOnce = async () => {
        calls += 1;
        if (calls === 1) throw failure;
    };

    await assert.rejects(instance.retire(failOnce), failure);
    assert.equal(instance.retired, true);
    assert.throws(() => instance.acquireLease(), /retired/u);

    const retry = instance.retire(failOnce);
    await retry;
    assert.strictEqual(instance.retire(failOnce), retry);
    assert.equal(calls, 2);
});
