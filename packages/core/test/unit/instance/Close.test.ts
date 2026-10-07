import assert from "node:assert/strict";
import test from "node:test";

import { Instance } from "../../../src/instance/model/Instance.ts";

function createHarness(options: { owned: boolean; failStopOnce?: boolean }) {
    let owned = options.owned;
    let failStop = options.failStopOnce ?? false;
    const events: string[] = [];
    const instance = new Instance({
        config: { name: "close-test" },
        eventLog: {
            async flush() {
                events.push("event.flush");
            },
            port: {},
        },
        state: {
            async close() {
                events.push("state.close");
            },
            async prepareRetirement() {
                events.push("state.prepareRetirement");
            },
            async retire() {
                events.push("state.retire");
            },
        },
        subscriptions: {
            close() {
                events.push("subscriptions.close");
            },
        },
        worker: {
            supervision: {
                async close() {
                    events.push("supervision.close");
                },
                lifecycle: {
                    async stop() {
                        events.push("worker.stop");
                        if (failStop) {
                            failStop = false;
                            throw new Error("stop failed");
                        }
                        return {};
                    },
                },
                ownership: {
                    clearOwned() {
                        owned = false;
                    },
                    get owned() {
                        return owned;
                    },
                },
            },
        },
    } as never);
    return {
        events,
        instance,
        get owned() {
            return owned;
        },
    };
}

test("Instance.close stops only owned workers and preserves failed ownership for retry", async () => {
    const unowned = createHarness({ owned: false });
    await unowned.instance.close();
    assert.equal(unowned.events.includes("worker.stop"), false);

    const owned = createHarness({ owned: true });
    await owned.instance.close();
    assert.equal(owned.owned, false);
    assert.ok(
        owned.events.indexOf("worker.stop") <
            owned.events.indexOf("supervision.close"),
    );

    const retry = createHarness({ failStopOnce: true, owned: true });
    await assert.rejects(retry.instance.close(), /stop failed/u);
    assert.equal(retry.owned, true);
    await retry.instance.close();
    assert.equal(retry.owned, false);
    assert.equal(
        retry.events.filter((event) => event === "worker.stop").length,
        2,
    );
});
