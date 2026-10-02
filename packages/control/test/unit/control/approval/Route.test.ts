import assert from "node:assert/strict";
import test from "node:test";

import type { ControlPortContext } from "@portable-devshell/shared";

import { createApprovalRouteModule } from "../../../../src/control/approval/Route.ts";

function context(): ControlPortContext {
    return {
        connectionId: "conn-1",
        host: "demo",
        peer: "tui",
        requestId: "req-1",
        signal: new AbortController().signal,
        afterReply() {},
    } as ControlPortContext;
}

test("approval routes list pending requests through the approval port", async () => {
    let allReads = 0;
    let pendingReads = 0;
    const module = createApprovalRouteModule({
        approval: {
            async listApprovals() {
                allReads += 1;
                return [];
            },
            async listPendingApprovals() {
                pendingReads += 1;
                return [{ approvalId: "pending-1" } as never];
            },
        } as never,
    });
    const list = module.operations.find((entry) => entry.name === "list");
    if (list === undefined) throw new Error("approval.list is missing");

    assert.deepEqual(
        await list.handle(
            { id: "1", name: "list", payload: { pendingOnly: true } },
            context(),
        ),
        [{ approvalId: "pending-1" }],
    );
    assert.equal(pendingReads, 1);
    assert.equal(allReads, 0);
});

test("approval routes expose only list, get, and decide", () => {
    const module = createApprovalRouteModule({ approval: {} as never });
    assert.deepEqual(
        module.operations.map((entry) => entry.name),
        ["list", "get", "decide"],
    );
});
