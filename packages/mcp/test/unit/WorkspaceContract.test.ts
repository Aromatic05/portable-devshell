import assert from "node:assert/strict";
import test from "node:test";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation";
import type { McpInteractionGateway } from "../../src/endpoint/Port.ts";
import {
    workspaceActionOutputSchema,
    workspaceSnapshotOutputSchema,
} from "../../src/endpoint/domain/interaction/Schema.ts";
import { readWorkspaceProjection } from "../../src/workspace/Snapshot.ts";

const validator = new AjvJsonSchemaValidator();
const validateSnapshot = validator.getValidator(
    workspaceSnapshotOutputSchema as JsonSchemaType,
);
const validateAction = validator.getValidator(
    workspaceActionOutputSchema as JsonSchemaType,
);

function questionGateway(): McpInteractionGateway {
    return {
        readTodo: async () => ({
            tasks: [{
                taskId: "task-one", ctxId: "ctx-one", revision: 2,
                title: "Review", status: "paused", completed: 1, total: 3,
            }],
        }),
        controlTodo: async () => ({}),
        listWaits: async () => [{
            waitId: "question-one", createdByCtxId: "ctx-one", kind: "question",
            targetId: "question-one", status: "waiting",
            updatedAt: "2026-10-02T00:00:00.000Z",
            payload: { question: "Choose a path", choices: ["Left", "Right"], allowText: false },
        }],
        resolveWait: async () => ({}),
        approval: { listPendingApprovals: async () => [], decideApproval: async () => ({}) },
    } as unknown as McpInteractionGateway;
}

test("projected Question choices and durable directives satisfy the MCP wire schemas", async () => {
    const effect = {
        kind: "reentry" as const, intent: "task-resume" as const,
        id: "receipt-one", sourceId: "task-one",
    };
    const { snapshot } = await readWorkspaceProjection(questionGateway(), "alpha", "ctx-one", {
        reentry: { pending: false, mode: "automatic" }, directives: [effect],
    });
    assert.equal(snapshot.presentation.primary?.kind, "question");
    const snapshotResult = validateSnapshot(snapshot);
    assert.equal(snapshotResult.valid, true, snapshotResult.errorMessage);
    const actionResult = validateAction({ status: "applied", snapshot, effect });
    assert.equal(actionResult.valid, true, actionResult.errorMessage);
});

test("Workspace wire schemas reject legacy fields and malformed presentation and delivery primitives", async () => {
    const { snapshot } = await readWorkspaceProjection(questionGateway(), "alpha", "ctx-one");
    assert.equal(validateSnapshot({ ...snapshot, tasks: [] }).valid, false);
    assert.equal(validateSnapshot({
        ...snapshot,
        presentation: { ...snapshot.presentation, primary: snapshot.presentation.work[0] },
    }).valid, false);
    assert.equal(validateSnapshot({
        ...snapshot,
        presentation: { ...snapshot.presentation, work: [snapshot.presentation.primary] },
    }).valid, false);
    assert.equal(validateSnapshot({
        ...snapshot,
        reentry: { pending: false, schedule: { readyAt: "2026-10-02T00:00:00.000Z", intent: "task-resume" } },
    }).valid, false);
    assert.equal(validateSnapshot({
        ...snapshot,
        reentry: { pending: false, delivery: { status: "sent" } },
    }).valid, false);
    assert.equal(validateAction({ status: "applied", snapshot, effect: {
        kind: "reentry", id: "receipt-one", intent: "task-resume", revision: 2,
    } }).valid, false);
});
