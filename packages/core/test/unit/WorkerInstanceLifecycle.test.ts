import assert from "node:assert/strict";
import test from "node:test";

import { errorCodes } from "@portable-devshell/shared";

import { WorkerInstanceLifecycle } from "../../src/worker/instance/WorkerInstanceLifecycle.ts";

test("self-managed workers reject Control start and stop without touching the remote lifecycle", async () => {
    let remoteStopCalls = 0;
    const lifecycle = new WorkerInstanceLifecycle({
        appendEvent: async () => undefined,
        applyStateUpdate: async () => ({}) as never,
        config: {
            managementMode: "selfManaged",
            name: "reverse-mac",
        } as never,
        connection: {
            async stopSelfManaged() {
                remoteStopCalls += 1;
                return {} as never;
            },
        } as never,
    });

    for (const operation of [() => lifecycle.start(), () => lifecycle.stop()]) {
        await assert.rejects(operation(), (error: unknown) => {
            assert.equal((error as { code?: string }).code, errorCodes.reverseSelfManagedLifecycle);
            assert.match((error as Error).message, /self-managed.*remote machine/iu);
            return true;
        });
    }
    assert.equal(remoteStopCalls, 0);
});
