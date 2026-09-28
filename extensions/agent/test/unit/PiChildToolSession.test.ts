import assert from "node:assert/strict";
import test from "node:test";

import { asInstanceName } from "@portable-devshell/shared";

import { PiChildToolSession } from "../../src/provider/pi/adapt/ChildToolSession.ts";
import { encodePiToolError } from "../../src/provider/pi/protocol/Process.ts";
import type {
    PiChildMessage,
    PiParentMessage,
} from "../../src/provider/pi/protocol/Process.ts";

test("Pi tool error encoding drops cyclic details without failing", () => {
    const details: Record<string, unknown> = {};
    details.self = details;
    const error = Object.assign(new Error("snapshot required"), {
        code: "file.snapshotRequired",
        details,
        retryable: true,
    });

    assert.deepEqual(encodePiToolError(error), {
        code: "file.snapshotRequired",
        message: "snapshot required",
        retryable: true,
    });
});

test("Pi child tool progress updates the pending call without resolving it", async () => {
    const sent: PiChildMessage[] = [];
    const progress: unknown[] = [];
    const session = new PiChildToolSession({
        agentId: "agent-a",
        modelTools: [
            {
                description: "Run bash",
                inputSchema: { type: "object" },
                name: "bash_run",
            },
        ],
        send(message) {
            sent.push(message);
        },
        target: { instance: asInstanceName("worker-a"), workspace: "/repo" },
        tools: [
            {
                description: "Run bash",
                inputSchema: { type: "object" },
                name: "bash_run",
            },
        ],
    });

    let settled = false;
    const pending = session
        .callTool(
            "bash_run",
            { command: "printf hi" },
            "operation-a",
            undefined,
            (value) => progress.push(value),
        )
        .finally(() => {
            settled = true;
        });
    await Promise.resolve();

    const call = sent.find(
        (message): message is Extract<PiChildMessage, { type: "tool.call" }> =>
            message.type === "tool.call",
    );
    assert.notEqual(call, undefined);
    assert.equal(call!.operationId, "operation-a");

    assert.equal(
        session.accept({
            agentId: "agent-a",
            callId: call!.callId,
            progress: { stdout: "partial" },
            type: "tool.progress",
        } satisfies PiParentMessage),
        true,
    );
    await Promise.resolve();
    assert.deepEqual(progress, [{ stdout: "partial" }]);
    assert.equal(settled, false);

    assert.equal(
        session.accept({
            agentId: "agent-a",
            callId: call!.callId,
            ok: true,
            result: { stdout: "partial\nfinal" },
            type: "tool.result",
        } satisfies PiParentMessage),
        true,
    );
    assert.deepEqual(await pending, { stdout: "partial\nfinal" });
    assert.equal(settled, true);
});

test("Pi child tool failures preserve structured error metadata", async () => {
    const sent: PiChildMessage[] = [];
    const session = new PiChildToolSession({
        agentId: "agent-a",
        modelTools: [
            {
                description: "Edit files",
                inputSchema: { type: "object" },
                name: "file_edit",
            },
        ],
        send(message) {
            sent.push(message);
        },
        target: { instance: asInstanceName("worker-a"), workspace: "/repo" },
        tools: [
            {
                description: "Edit files",
                inputSchema: { type: "object" },
                name: "file_edit",
            },
        ],
    });

    const pending = session.callTool(
        "file_edit",
        { changes: "..." },
        "operation-a",
    );
    await Promise.resolve();
    const call = sent.find(
        (message): message is Extract<PiChildMessage, { type: "tool.call" }> =>
            message.type === "tool.call",
    );
    assert.notEqual(call, undefined);

    assert.equal(
        session.accept({
            agentId: "agent-a",
            callId: call!.callId,
            error: {
                code: "file.snapshotRequired",
                details: { path: "./document.txt" },
                message: "snapshot required",
                retryable: true,
            },
            ok: false,
            type: "tool.result",
        } satisfies PiParentMessage),
        true,
    );

    await assert.rejects(pending, (error: unknown) => {
        assert.ok(error instanceof Error);
        const structured = error as Error & {
            code?: string;
            details?: unknown;
            retryable?: boolean;
        };
        assert.equal(structured.code, "file.snapshotRequired");
        assert.deepEqual(structured.details, { path: "./document.txt" });
        assert.equal(structured.retryable, true);
        return true;
    });
});
