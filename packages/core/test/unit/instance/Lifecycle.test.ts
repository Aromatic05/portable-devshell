import assert from "node:assert/strict";
import test from "node:test";

import { runtimeErrorCodes } from "@portable-devshell/shared";

import { Instance } from "../../../src/instance/model/Instance.ts";
import { ReverseExecution } from "../../../src/instance/runtime/execution/provider/Reverse.ts";

function createInstance(
    name: string,
    state: {
        prepareRetirement?: () => Promise<void>;
        retire?: () => Promise<void>;
    } = {},
): Instance {
    return new Instance({
        config: { name } as never,
        eventLog: { async flush() {} } as never,
        state: {
            async close() {},
            async prepareRetirement() {
                await state.prepareRetirement?.();
            },
            async retire() {
                await state.retire?.();
            },
        } as never,
        subscriptions: { close() {} } as never,
        worker: {} as never,
    });
}

test("self-managed worker execution rejects controller start and stop", () => {
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

test("instance retirement blocks new leases and drains existing work", async () => {
    const events: string[] = [];
    const instance = createInstance("reverse-mac", {
        prepareRetirement: async () => {
            events.push("prepare");
        },
        retire: async () => {
            events.push("retire");
        },
    });
    const lease = instance.lifecycle.acquireLease();
    const retirement = instance.retire();

    assert.equal(instance.lifecycle.active, false);
    assert.equal(instance.lifecycle.phase, "retiring");
    assert.strictEqual(instance.retire(), retirement);
    assert.throws(() => instance.lifecycle.acquireLease(), /retired/u);

    await Promise.resolve();
    assert.deepEqual(events, ["prepare"]);
    lease.release();
    await retirement;

    assert.deepEqual(events, ["prepare", "retire"]);
    assert.equal(instance.lifecycle.retired, true);
    assert.equal(instance.lifecycle.phase, "retired");
});

test("failed instance retirement can retry without reopening admission", async () => {
    const failure = new Error("approval retirement failed once");
    let prepareCalls = 0;
    const instance = createInstance("retry", {
        prepareRetirement: async () => {
            prepareCalls += 1;
            if (prepareCalls === 1) throw failure;
        },
    });

    await assert.rejects(instance.retire(), failure);
    assert.equal(instance.lifecycle.phase, "retiring");
    assert.throws(() => instance.lifecycle.acquireLease(), /retired/u);

    const retry = instance.retire();
    await retry;
    assert.strictEqual(instance.retire(), retry);
    assert.equal(instance.lifecycle.phase, "retired");
    assert.equal(prepareCalls, 2);
});
