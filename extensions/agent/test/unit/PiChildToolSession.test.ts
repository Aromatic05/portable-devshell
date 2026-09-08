import assert from "node:assert/strict";
import test from "node:test";

import { asInstanceName } from "@portable-devshell/shared";

import { PiChildToolSession } from "../../src/provider/pi/PiChildToolSession.ts";
import type { PiChildMessage, PiParentMessage } from "../../src/provider/pi/PiProcessProtocol.ts";


test("Pi child tool progress updates the pending call without resolving it", async () => {
    const sent: PiChildMessage[] = [];
    const progress: unknown[] = [];
    const session = new PiChildToolSession({
        agentId: "agent-a",
        send(message) {
            sent.push(message);
        },
        target: { instance: asInstanceName("worker-a"), workspace: "/repo" },
        tools: [{ description: "Run bash", inputSchema: { type: "object" }, name: "bash_run" }]
    });

    let settled = false;
    const pending = session.callTool(
        "bash_run",
        { command: "printf hi" },
        "operation-a",
        undefined,
        (value) => progress.push(value)
    ).finally(() => {
        settled = true;
    });
    await Promise.resolve();

    const call = sent.find((message): message is Extract<PiChildMessage, { type: "tool.call" }> =>
        message.type === "tool.call"
    );
    assert.notEqual(call, undefined);
    assert.equal(call!.operationId, "operation-a");

    assert.equal(session.accept({
        agentId: "agent-a",
        callId: call!.callId,
        progress: { stdout: "partial" },
        type: "tool.progress"
    } satisfies PiParentMessage), true);
    await Promise.resolve();
    assert.deepEqual(progress, [{ stdout: "partial" }]);
    assert.equal(settled, false);

    assert.equal(session.accept({
        agentId: "agent-a",
        callId: call!.callId,
        ok: true,
        result: { stdout: "partial\nfinal" },
        type: "tool.result"
    } satisfies PiParentMessage), true);
    assert.deepEqual(await pending, { stdout: "partial\nfinal" });
    assert.equal(settled, true);
});
