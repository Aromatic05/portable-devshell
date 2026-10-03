import assert from "node:assert/strict";
import test from "node:test";

import type {
    ApprovalEvent,
    ControlPortContext,
    InstanceEventRecord,
} from "@portable-devshell/shared";

import { createApprovalRouteModule } from "../../../src/approval/Route.ts";

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
    const module = createApprovalRouteModule(
        {
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
            name: "demo",
            worker: {
                snapshot: () => ({ lastSeq: 7 }),
            } as never,
        },
        {
            async subscribe() {},
        },
    );
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

test("approval snapshot pairs the pending list with a replay cursor", async () => {
    const module = createApprovalRouteModule(
        {
            approval: {
                async listPendingApprovals() {
                    return [{ approvalId: "pending-1" } as never];
                },
            } as never,
            name: "demo",
            worker: {
                snapshot: () => ({ lastSeq: 7 }),
            } as never,
        },
        { async subscribe() {} },
    );
    const snapshot = module.operations.find(
        (entry) => entry.name === "snapshot",
    );
    if (snapshot === undefined) throw new Error("approval.snapshot is missing");
    assert.deepEqual(
        await snapshot.handle(
            {
                id: "snapshot",
                name: "snapshot",
                payload: { pendingOnly: true },
            },
            context(),
        ),
        {
            approvals: [{ approvalId: "pending-1" }],
            lastSeq: 7,
        },
    );
});

test("approval routes expose legacy reads plus snapshot and subscribe", () => {
    const module = createApprovalRouteModule(
        {
            approval: {} as never,
            name: "demo",
            worker: {} as never,
        },
        { async subscribe() {} },
    );
    assert.deepEqual(
        module.operations.map((entry) => entry.name),
        ["list", "snapshot", "get", "decide"],
    );
    assert.deepEqual(
        module.streams?.map((entry) => entry.name),
        ["subscribe"],
    );
});

test("approval subscribe uses the shared runtime stream with approval filter", async () => {
    let fromSeq: number | undefined;
    let instanceName: string | undefined;
    let project:
        ((event: InstanceEventRecord) => ApprovalEvent | undefined) | undefined;
    const module = createApprovalRouteModule(
        {
            approval: {} as never,
            name: "demo",
            worker: {} as never,
        },
        {
            async subscribe(
                _stream,
                _context,
                nextInstanceName,
                _worker,
                nextFromSeq,
                nextProject,
            ) {
                fromSeq = nextFromSeq;
                instanceName = nextInstanceName;
                project = nextProject;
            },
        },
    );
    const subscribe = module.streams?.find(
        (entry) => entry.name === "subscribe",
    );
    if (subscribe === undefined)
        throw new Error("approval.subscribe is missing");
    await subscribe.handle(
        {} as never,
        { id: "2", name: "subscribe", payload: { fromSeq: 8 } },
        context(),
    );
    assert.equal(fromSeq, 8);
    assert.equal(instanceName, "demo");
    const approval = {
        at: "2026-10-03T00:00:00.000Z",
        instanceName: "demo",
        seq: 9,
        type: "approval.requested",
    } as InstanceEventRecord;
    assert.deepEqual(project?.(approval), approval);
    assert.equal(
        project?.({ ...approval, type: "todo.updated" } as InstanceEventRecord),
        undefined,
    );
});
