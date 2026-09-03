import assert from "node:assert/strict";
import test from "node:test";

import { deliverPiAgentMessage } from "../../src/provider/pi/PiAgentCommands.ts";
import type { PiSessionLike } from "../../src/provider/pi/PiSdkLoader.ts";

function fakeSession(streaming: boolean) {
    const calls: Array<{ options?: { streamingBehavior?: "steer" | "followUp" }; text: string }> = [];
    const session: PiSessionLike = {
        isStreaming: streaming,
        sessionId: "session-1",
        async abort() {},
        dispose() {},
        async prompt(text, options) {
            calls.push(options === undefined ? { text } : { options, text });
        }
    };
    return { calls, session };
}

test("Pi prompt starts a turn when idle and steers an active turn when streaming", async () => {
    const idle = fakeSession(false);
    const streaming = fakeSession(true);

    await deliverPiAgentMessage(idle.session, "prompt", "implement");
    await deliverPiAgentMessage(streaming.session, "prompt", "focus tests");

    assert.deepEqual(idle.calls, [{ text: "implement" }]);
    assert.deepEqual(streaming.calls, [{
        options: { streamingBehavior: "steer" },
        text: "focus tests"
    }]);
});

test("Pi steer starts a turn when idle instead of silently queueing steering", async () => {
    const idle = fakeSession(false);
    const streaming = fakeSession(true);

    await deliverPiAgentMessage(idle.session, "steer", "implement");
    await deliverPiAgentMessage(streaming.session, "steer", "focus tests");

    assert.deepEqual(idle.calls, [{ text: "implement" }]);
    assert.deepEqual(streaming.calls, [{
        options: { streamingBehavior: "steer" },
        text: "focus tests"
    }]);
});

test("Pi follow-up remains queued regardless of current streaming state", async () => {
    const idle = fakeSession(false);
    const streaming = fakeSession(true);

    await deliverPiAgentMessage(idle.session, "followUp", "review after");
    await deliverPiAgentMessage(streaming.session, "followUp", "review later");

    assert.deepEqual(idle.calls, [{
        options: { streamingBehavior: "followUp" },
        text: "review after"
    }]);
    assert.deepEqual(streaming.calls, [{
        options: { streamingBehavior: "followUp" },
        text: "review later"
    }]);
});
