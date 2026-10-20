import assert from "node:assert/strict";
import test from "node:test";

import { WorkerInstanceRetirement } from "../../../src/instance/runtime/provision/Retirement.ts";

test("worker retirement attempts provider cleanup even after runtime retirement fails", async () => {
    const calls: string[] = [];
    const retirement = new WorkerInstanceRetirement({
        config: { name: "retirement-test" } as never,
        commandClient: {
            async stop() {
                calls.push("stop");
                return { exitCode: 0 };
            },
            async retireRuntime() {
                calls.push("runtime");
                return { exitCode: 1, details: {} };
            },
            async retireProviderResources() {
                calls.push("provider");
                throw new Error("provider cleanup failed");
            },
        } as never,
    });

    await assert.rejects(retirement.retire(), (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.length, 2);
        return true;
    });
    assert.deepEqual(calls, ["stop", "runtime", "provider"]);
});

test("worker retirement can skip the runtime but still release provider resources", async () => {
    const calls: string[] = [];
    const retirement = new WorkerInstanceRetirement({
        config: { name: "retirement-test" } as never,
        commandClient: {
            async stop() {
                calls.push("stop");
                return { exitCode: 0 };
            },
            async retireRuntime() {
                calls.push("runtime");
                return { exitCode: 0 };
            },
            async retireProviderResources() {
                calls.push("provider");
            },
        } as never,
    });

    await retirement.retire(true);
    assert.deepEqual(calls, ["provider"]);
});

for (const exitCode of [1, null]) {
    test(`failed or ambiguous stop (${exitCode}) retains failure and never retires the runtime`, async () => {
        const calls: string[] = [];
        const retirement = new WorkerInstanceRetirement({
            config: { name: "retirement-test" } as never,
            commandClient: {
                async stop() {
                    calls.push("stop");
                    return { exitCode, details: { stderrTail: "stop did not complete" } };
                },
                async retireRuntime() {
                    calls.push("runtime");
                    return { exitCode: 0 };
                },
                async retireProviderResources() { calls.push("provider"); },
            } as never,
        });
        await assert.rejects(retirement.retire(), (error: unknown) => {
            assert.ok(error instanceof AggregateError);
            assert.match(error.errors[0].message, /Worker runtime stop failed/);
            assert.equal(error.errors[0].details.stderrTail, "stop did not complete");
            return true;
        });
        assert.deepEqual(calls, ["stop", "provider"]);
    });
}

test("managed retirement stops before retiring and accepts already absent resources", async () => {
    const calls: string[] = [];
    const retirement = new WorkerInstanceRetirement({
        config: { name: "retirement-test" } as never,
        commandClient: {
            async stop() { calls.push("stop"); return { exitCode: 0, stdout: '{"stopped":false}' }; },
            async retireRuntime() { calls.push("runtime"); return { exitCode: 0, stdout: '{"retired":false}' }; },
            async retireProviderResources() { calls.push("provider"); },
        } as never,
    });
    await retirement.retire();
    await retirement.retire();
    assert.deepEqual(calls, ["stop", "runtime", "provider", "stop", "runtime", "provider"]);
});
