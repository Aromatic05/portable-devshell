import assert from "node:assert/strict";
import test from "node:test";

import { toControlErrorBody } from "@portable-devshell/shared";

import { CommentReportService } from "../../src/comment/report/Service.ts";

function createHarness() {
    let now = Date.parse("2026-09-14T00:00:00.000Z");
    let callSequence = 0;
    let failNext = false;
    let pendingReplyCommentId: string | undefined;
    let pendingPush: { commentId: string; message: string } | undefined;
    const entries: Array<Record<string, unknown>> = [];
    const reports: string[] = [];
    const service = new CommentReportService({
        comment: {
            async pendingReport() {
                return {
                    ...(pendingPush === undefined
                        ? {}
                        : { push: { ...pendingPush } }),
                    ...(pendingReplyCommentId === undefined
                        ? {}
                        : { replyCommentId: pendingReplyCommentId }),
                };
            },
        },
        conversation: {
            async list(input = {}) {
                const filtered = entries.filter(
                    (entry) =>
                        input.ctxId === undefined ||
                        entry.ctxId === input.ctxId,
                );
                return (input.limit === undefined
                    ? filtered
                    : filtered.slice(-input.limit)) as never;
            },
            async recordReport(input) {
                if (failNext) {
                    failNext = false;
                    throw new Error("report failed");
                }
                reports.push(input.text);
                entries.push({
                    callId: input.callId,
                    createdAt: new Date(now).toISOString(),
                    ctxId: input.ctxId,
                    id: input.callId,
                    kind: "report",
                    text: input.text,
                });
                if (
                    input.replyCommentId !== undefined &&
                    input.replyCommentId === pendingReplyCommentId
                ) {
                    pendingReplyCommentId = undefined;
                }
                if (
                    input.push !== undefined &&
                    pendingPush?.commentId === input.push.commentId &&
                    pendingPush.message === input.push.message
                ) {
                    pendingPush = undefined;
                }
            },
        },
        now: () => now,
    });
    const ctxId = "ctx-report-policy";

    return {
        advance(milliseconds: number) {
            now += milliseconds;
        },
        async before(toolName: string) {
            await service.beforeTodoToolCall(ctxId, toolName);
        },
        deliverComment(id: string, text: string) {
            entries.push({
                callId: `delivery-${id}`,
                createdAt: new Date(now).toISOString(),
                ctxId,
                deliveredAt: new Date(now).toISOString(),
                id,
                kind: "comment",
                status: "delivered",
                text,
            });
            pendingReplyCommentId = id;
        },
        failNextReport() {
            failNext = true;
        },
        push(message: string) {
            pendingPush = {
                commentId: `push-${callSequence}`,
                message,
            };
        },
        async report(message: string) {
            callSequence += 1;
            await service.report(ctxId, message, `report-${callSequence}`);
        },
        reports,
        service,
    };
}

async function assertUseOtherTools(operation: Promise<unknown>): Promise<void> {
    await assert.rejects(operation, (error: unknown) => {
        const body = toControlErrorBody(error);
        assert.equal(body?.code, "todo.invalid");
        assert.equal(body?.retryable, false);
        assert.equal(
            body?.message,
            "You have performed too many useless operations. Use other tools.",
        );
        assert.equal(
            typeof body?.details === "object" &&
                body.details !== null &&
                !Array.isArray(body.details)
                ? body.details.action
                : undefined,
            "use_other_tools",
        );
        return true;
    });
}

test("Comment report policy rate-limits autonomous updates with fractional refill", async () => {
    const harness = createHarness();

    await harness.report("first");
    await harness.report("second");
    await assertUseOtherTools(harness.report("third"));
    harness.advance(15_000);
    await assertUseOtherTools(harness.report("third"));
    harness.advance(15_000);
    await harness.report("third");
    harness.advance(60_000);
    await harness.report("fourth");
    await harness.report("fifth");
    await assertUseOtherTools(harness.report("sixth"));

    assert.deepEqual(harness.reports, [
        "first",
        "second",
        "third",
        "fourth",
        "fifth",
    ]);
});

test("Comment report policy rejects duplicate autonomous reports without spending a token", async () => {
    const harness = createHarness();

    await harness.report("same");
    await assert.rejects(harness.report("same"), (error: unknown) => {
        assert.equal(toControlErrorBody(error)?.code, "todo.invalid");
        assert.equal(
            (toControlErrorBody(error)?.details as { reason?: string } | undefined)
                ?.reason,
            "duplicate",
        );
        return true;
    });
    await harness.report("second");
    await assertUseOtherTools(harness.report("third"));
});

test("Comment report policy disables Todo after repeated invalid operations and expires the ban", async () => {
    const harness = createHarness();

    await harness.report("same");
    for (let index = 0; index < 3; index += 1) {
        await assert.rejects(
            harness.report("same"),
            (error: unknown) => toControlErrorBody(error)?.code === "todo.invalid",
        );
    }

    await assertUseOtherTools(harness.before("todo_read"));
    harness.advance(299_999);
    await assertUseOtherTools(harness.before("todo_report"));
    harness.advance(1);
    await harness.before("todo_report");
});

test("Comment report policy forgets invalid operations outside the rolling window", async () => {
    const harness = createHarness();

    await harness.report("same");
    for (let index = 0; index < 2; index += 1) {
        await assert.rejects(
            harness.report("same"),
            (error: unknown) => toControlErrorBody(error)?.code === "todo.invalid",
        );
    }
    harness.advance(120_000);
    await assert.rejects(
        harness.report("same"),
        (error: unknown) => toControlErrorBody(error)?.code === "todo.invalid",
    );
    await harness.report("new information");
});

test("Comment report policy serializes concurrent autonomous reports", async () => {
    const harness = createHarness();

    const results = await Promise.allSettled([
        harness.report("parallel one"),
        harness.report("parallel two"),
        harness.report("parallel three"),
    ]);

    assert.equal(
        results.filter((result) => result.status === "fulfilled").length,
        2,
    );
    assert.equal(
        results.filter((result) => result.status === "rejected").length,
        1,
    );
    assert.equal(harness.reports.length, 2);
});

test("Comment report policy keeps Todo access and report buckets independent", async () => {
    const harness = createHarness();

    await harness.before("todo_read");
    await harness.before("todo_write");
    await assertUseOtherTools(harness.before("todo_read"));

    await harness.report("report one");
    await harness.report("report two");
    await assertUseOtherTools(harness.report("report three"));

    harness.advance(30_000);
    await harness.before("todo_write");
    await harness.report("report three");
});

test("Comment report policy serializes concurrent Todo access", async () => {
    const harness = createHarness();

    const results = await Promise.allSettled([
        harness.before("todo_read"),
        harness.before("todo_write"),
        harness.before("todo_read"),
    ]);

    assert.equal(
        results.filter((result) => result.status === "fulfilled").length,
        2,
    );
    assert.equal(
        results.filter((result) => result.status === "rejected").length,
        1,
    );
});

test("Comment report obligations bypass autonomous throttling and clear only after persistence succeeds", async () => {
    const harness = createHarness();
    await harness.report("autonomous one");
    await harness.report("autonomous two");
    harness.push("#push report progress");

    harness.failNextReport();
    await assert.rejects(harness.report("required reply"), /report failed/u);
    await harness.report("required reply");
    await assertUseOtherTools(harness.report("autonomous after push"));

    harness.deliverComment("comment-reply", "Reply to this too");
    harness.failNextReport();
    await assert.rejects(harness.report("reply"), /report failed/u);
    await harness.report("reply");
});
