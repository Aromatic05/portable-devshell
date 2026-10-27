import assert from "node:assert/strict";
import test from "node:test";
import { realWorkerTestOptions } from "../../../../test/TestPlatformSupport.ts";
import {
    INBOX,
    mail,
    OUTBOX,
    realMemory,
    STATE,
    workerBinary,
} from "../helpers/RealMemory.ts";
import { createCommentDelivery } from "../../src/index.ts";
import { createMemoryAutoHook } from "../../src/mailing/Hook.ts";

test(
    "Automatic Memory binding cannot consume the MCP caller's queued Comment through nested Extension tools",
    realWorkerTestOptions(workerBinary),
    async (t) => {
        const f = await realMemory(t);
        const service = f.newMailing();
        const delivery = createCommentDelivery({
            consumePending: async (instance, ctxId, callId) => {
                assert.equal(instance, f.instance);
                return await f.comment.consumePending(ctxId, callId);
            },
        });
        const invocation = {
            signal: new AbortController().signal,
            async requestInterface(): Promise<never> {
                throw new Error("unused interface");
            },
        };
        const context = { ...f.owner, source: "mcp" as const };
        const queued = await f.comment.queue({
            ctxId: context.ctxId,
            text: "Preserve my constraint",
        });
        let nestedCalls = 0;
        // The real worker.execute capability routes each session tool through
        // ToolCall hooks with the session's Context and source=extension. This
        // fixture normally invokes Rust directly; restore that outbound boundary.
        f.setAfterTool(async (toolName, _input, payload) => {
            const value = {
                context: { ...context, source: "extension" as const },
                kind: "result" as const,
                payload,
                toolName,
            };
            const rewritten = await delivery(
                {
                    callId: `internal-${++nestedCalls}`,
                    direction: "outbound",
                    value,
                },
                invocation,
            );
            assert.deepEqual(rewritten, value);
        });
        const auto = createMemoryAutoHook(service, (error) => {
            throw error;
        });
        await auto(
            {
                callId: "mcp-call",
                direction: "inbound",
                value: {
                    context,
                    kind: "call",
                    toolName: "bash_run",
                    payload: { command: "pwd" },
                },
            },
            invocation,
        );
        assert.ok(
            nestedCalls > 0,
            "automatic binding must execute real nested Worker tools",
        );
        assert.ok((await service.status(f.owner)).name);
        assert.equal((await f.comment.list(context.ctxId))[0]?.status, "sent");

        const result = await delivery(
            {
                callId: "mcp-call",
                direction: "outbound",
                value: {
                    context,
                    kind: "result",
                    toolName: "bash_run",
                    payload: { stdout: "ok", exitCode: 0 },
                },
            },
            invocation,
        );
        assert.deepEqual(result.payload, {
            stdout: "ok",
            exitCode: 0,
            comment: [queued.text],
        });
        const [delivered] = await f.comment.list(context.ctxId);
        assert.equal(delivered?.id, queued.id);
        assert.equal(delivered?.status, "delivered");
        assert.equal(delivered?.callId, "mcp-call");
        assert.equal(
            f.events.filter((type) => type === "context.message.delivered")
                .length,
            1,
        );
        assert.deepEqual(f.errors, []);
    },
);

// Explicit integration target: excluded from the package's unit/*.test.ts glob.
// No in-memory or disk capability substitute is selected when IPC is unavailable.
test("Real Rust IPC: Memory inheritance, mail append, SQLite notification and restart dedup", realWorkerTestOptions(workerBinary), async (t) => {
    const f = await realMemory(t);
    const service = f.newMailing();
    await service.init(f.owner, "receiver");
    await f.put(OUTBOX, mail());
    await Promise.all(Array.from({ length: 8 }, () => service.scan(f.target)));
    assert.equal((await f.read(INBOX)).split("<!-- MAIL ID sender#1 -->").length - 1, 1);
    const notices = await f.comment.list("owner");
    assert.equal(notices.length, 1);
    assert.deepEqual((await f.comment.consumePending("owner", "delivered")).messages.map(({ id }) => id), [notices[0]!.id]);
    await service.close();
    await f.restartComment();
    const recovered = f.newMailing();
    await recovered.poll();
    assert.equal((await f.comment.list("owner")).length, 1);
    await recovered.inherit({ ...f.owner, ctxId: "successor" }, "receiver");
    assert.deepEqual(await recovered.status(f.owner), {});
    assert.equal((await recovered.status({ ...f.owner, ctxId: "successor" })).name, "receiver");
    assert.deepEqual(JSON.parse(await f.read(STATE)).pendingNotices, {});
    assert.deepEqual(f.errors, []);
});
