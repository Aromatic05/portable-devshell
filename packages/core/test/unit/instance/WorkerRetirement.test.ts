import assert from "node:assert/strict";
import test from "node:test";

import { WorkerInstanceRetirement } from "../../../src/instance/runtime/provision/Retirement.ts";

test("worker retirement attempts provider cleanup even after runtime retirement fails", async () => {
    const calls: string[] = [];
    const retirement = new WorkerInstanceRetirement({
        config: { name: "retirement-test" } as never,
        commandClient: {
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
    assert.deepEqual(calls, ["runtime", "provider"]);
});

test("worker retirement can skip the runtime but still release provider resources", async () => {
    const calls: string[] = [];
    const retirement = new WorkerInstanceRetirement({
        config: { name: "retirement-test" } as never,
        commandClient: {
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
