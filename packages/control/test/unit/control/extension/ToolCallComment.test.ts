import assert from "node:assert/strict";
import test from "node:test";

import { commentReviewInterfaceOperation } from "@portable-devshell/extension/comment";
import type { ToolCallReviewInvocation } from "@portable-devshell/extension/toolcall";

import { ToolCallCommentReview } from "../../../../src/control/extension/toolcall/interface/Comment.ts";
import type { InstanceDescriptor } from "../../../../src/control/instance/Descriptor.ts";
import { InstanceRegistry } from "../../../../src/control/instance/registry/Registry.ts";

const input: ToolCallReviewInvocation = {
    context: {
        ctxId: "ctx-1",
        instance: "demo",
        requestId: "request-1",
        source: "mcp",
    },
    direction: "inbound",
    kind: "call",
    payload: { command: "pwd" },
    signal: new AbortController().signal,
    toolName: "bash_run",
};

test("ToolCall Comment interface exposes only the current review decision to the builtin Comment Extension", async () => {
    const calls: unknown[] = [];
    const instances = new InstanceRegistry([
        {
            contextMessages: {
                async reviewToolCall(ctxId: string, toolName: string, requestId?: string) {
                    calls.push({ ctxId, requestId, toolName });
                    return { commentId: "comment-stop", kind: "stop" as const };
                },
            },
            name: "demo",
        } as unknown as InstanceDescriptor,
    ]);
    const review = new ToolCallCommentReview(instances);

    assert.deepEqual(
        await review
            .context("comment", input)
            .requestInterface(commentReviewInterfaceOperation),
        { commentId: "comment-stop", kind: "stop" },
    );
    assert.deepEqual(calls, [
        { ctxId: "ctx-1", requestId: "request-1", toolName: "bash_run" },
    ]);
});

test("ToolCall Comment interface is invocation-scoped and unavailable to other Extensions", async () => {
    const review = new ToolCallCommentReview(new InstanceRegistry([]));

    await assert.rejects(
        review
            .context("other", input)
            .requestInterface(commentReviewInterfaceOperation),
        /Unsupported ToolCall review interface operation/u,
    );
    await assert.rejects(
        review
            .context("comment", input)
            .requestInterface(commentReviewInterfaceOperation, { ctxId: "other" }),
        /does not accept Extension-provided input/u,
    );
    await assert.rejects(
        review.context("comment", input).requestInterface("comment.other"),
        /Unsupported ToolCall review interface operation/u,
    );
});
