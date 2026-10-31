import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCommentAdvice, createCommentDelivery, createCommentRetention } from "@portable-devshell/comment-extension";
import { asInstanceName } from "@portable-devshell/shared";

import { createWorkerArtifact } from "../../../../core/src/instance/runtime/execution/capability/artifact/Artifact.ts";
import { createTestInstance } from "../../../../mcp/test/ContextRuntime.ts";
import { presentMcpEndpointResult, McpNativeToolResult } from "../../../../mcp/src/protocol/call/Boundary.ts";
import { CommentService } from "../../../../../extensions/comment/src/comment/CommentService.ts";
import { MessageStore } from "../../../../../extensions/comment/src/message/store/MessageStore.ts";
import { databaseConnection } from "../../../../../extensions/comment/test/helpers/Database.ts";
import { realWorkerTestOptions, resolveTestWorkerBinary } from "../../../../../test/TestPlatformSupport.ts";

const workerBinary = resolveTestWorkerBinary();

test("long queued Comment survives native MCP presentation and is recovered with real Worker file_read",
    realWorkerTestOptions(workerBinary), async (t) => {
        assert.ok(workerBinary);
        const directory = await mkdtemp(join(tmpdir(), "devshell-comment-model-hci-"));
        const name = asInstanceName("comment-model-hci");
        const instance = createTestInstance({
            name,
            homeDirectory: directory,
            workerBinaryPath: workerBinary,
            env: { ...process.env, HOME: directory },
        });
        const databasePath = join(directory, "messages.sqlite3");
        const store = new MessageStore({
            filePath: databasePath,
            instanceName: name,
            openDatabase: () => databaseConnection(databasePath),
        });
        t.after(async () => {
            await store.close();
            await instance.close();
            await rm(directory, { recursive: true, force: true });
        });
        await instance.start();
        const comment = new CommentService({
            store,
            instanceName: name,
            appendEvent: async () => undefined,
        });
        const text = Array.from({ length: 90 }, (_, i) =>
            `用户 Comment 第 ${i + 1} 行：完整保留指令 ${"测试内容".repeat(10)}`,
        ).join("\n");
        const queued = await comment.queue({ ctxId: "ctx-model", text });
        const input = {
            callId: "call-native-comment",
            direction: "outbound" as const,
            value: {
                context: { ctxId: "ctx-model", instance: name, source: "mcp" as const },
                kind: "result" as const,
                payload: {
                    content: [{ type: "image", data: "image-data", mimeType: "image/png" }],
                    structuredContent: { name: "image.png" },
                },
                toolName: "artifact_viewImage",
            },
        };
        const invocation = {
            signal: new AbortController().signal,
            async requestInterface(): Promise<never> {
                throw new Error("Comment retention does not request a host interface");
            },
        };
        const advice = await createCommentAdvice()(input, invocation);
        const delivery = createCommentDelivery({
            consumePending: async (_instance, ctxId, callId) => await comment.consumePending(ctxId, callId),
        });
        const delivered = await delivery({ ...input, value: advice }, invocation);
        const artifacts = createWorkerArtifact(instance.worker.endpoint, `${name}-worker`);
        const retention = createCommentRetention(async (target, content) => {
            assert.equal(target, name);
            assert.equal(content, text);
            return await artifacts.retainText(content);
        });
        const retained = await retention({ ...input, value: delivered }, invocation);
        const presented = presentMcpEndpointResult(retained.payload, true);
        assert.ok(presented instanceof McpNativeToolResult);
        const model = presented.structuredContent as {
            comment?: string[];
            commentBytes?: number;
            commentInstance?: string;
            commentPath?: string;
            name?: string;
        };
        assert.equal(model.name, "image.png");
        assert.equal(model.commentInstance, name);
        assert.equal(model.commentBytes, Buffer.byteLength(text));
        assert.match(model.comment?.[0] ?? "", /file_read/u);
        const commentPath = model.commentPath;
        assert.ok(typeof commentPath === "string");
        assert.match(commentPath, /^\/.devshell\/tool-results\/[a-z0-9-]+\/stdout$/u);
        assert.deepEqual(presented.content, input.value.payload.content);
        const read = await instance.runtime.execution.invokeInternal("file_read", {
            files: [{ path: commentPath, view: "content", selector: "1-90:raw" }],
        }, { source: "extension", workspace: directory });
        const files = (read as { files: Array<{ path: string; content: string }> }).files;
        assert.equal(files[0]?.path, model.commentPath);
        const original = files[0]!.content.split("\n").map((line) => line.replace(/^\d+:/u, "")).join("\n");
        assert.equal(original, text);
        const [record] = await comment.list("ctx-model");
        assert.equal(record?.id, queued.id);
        assert.equal(record?.status, "delivered");
    },
);
