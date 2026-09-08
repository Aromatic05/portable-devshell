import assert from "node:assert/strict";
import test from "node:test";

import { deliverPiAgentMessage } from "../../src/provider/pi/PiAgentCommands.ts";
import type { PiSessionLike } from "../../src/provider/pi/PiSdkLoader.ts";

interface PromptOptionsLike {
    preflightResult?: (success: boolean) => void;
    streamingBehavior?: "steer" | "followUp";
}

interface PromptCall {
    options?: PromptOptionsLike;
    text: string;
}

function deferred(): { promise: Promise<void>; resolve(): void } {
    let resolve = () => {};
    const promise = new Promise<void>((value) => {
        resolve = value;
    });
    return { promise, resolve };
}

function fakeSession(
    streaming: boolean,
    options: { holdTurn?: boolean; preflightError?: Error } = {}
) {
    const calls: PromptCall[] = [];
    const followUps: string[] = [];
    const turn = deferred();
    const session = {
        isStreaming: streaming,
        sessionId: "session-1",
        async abort() {},
        dispose() {},
        async followUp(text: string) {
            followUps.push(text);
        },
        async prompt(text: string, promptOptions?: PromptOptionsLike) {
            calls.push(promptOptions === undefined ? { text } : { options: promptOptions, text });
            if (options.preflightError !== undefined) {
                promptOptions?.preflightResult?.(false);
                throw options.preflightError;
            }
            promptOptions?.preflightResult?.(true);
            if (options.holdTurn === true) await turn.promise;
        }
    } as PiSessionLike;
    return { calls, followUps, session, turn };
}

test("Pi prompt is accepted after preflight without waiting for the active turn", async () => {
    const idle = fakeSession(false, { holdTurn: true });
    let delivered = false;
    const delivery = deliverPiAgentMessage(idle.session, "prompt", "implement").then(() => {
        delivered = true;
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    const acceptedBeforeCompletion = delivered;
    idle.turn.resolve();
    await delivery;

    assert.equal(idle.calls.length, 1);
    assert.equal(idle.calls[0]?.text, "implement");
    assert.equal(typeof idle.calls[0]?.options?.preflightResult, "function");
    assert.equal(acceptedBeforeCompletion, true);
});

test("Pi prompt still returns the original preflight rejection", async () => {
    const expected = new Error("No model selected");
    const idle = fakeSession(false, { preflightError: expected });

    await assert.rejects(
        deliverPiAgentMessage(idle.session, "prompt", "implement"),
        (error) => error === expected
    );
});

test("Pi prompt and steer both steer an active turn", async () => {
    const prompt = fakeSession(true);
    const steer = fakeSession(true);

    await deliverPiAgentMessage(prompt.session, "prompt", "focus tests");
    await deliverPiAgentMessage(steer.session, "steer", "focus docs");

    assert.equal(prompt.calls[0]?.options?.streamingBehavior, "steer");
    assert.equal(steer.calls[0]?.options?.streamingBehavior, "steer");
});

test("Pi steer starts a normal prompt when the Agent is idle", async () => {
    const idle = fakeSession(false);

    await deliverPiAgentMessage(idle.session, "steer", "implement");

    assert.equal(idle.calls[0]?.text, "implement");
    assert.equal(idle.calls[0]?.options?.streamingBehavior, undefined);
});

test("Pi follow-up uses the provider queue without starting an idle turn", async () => {
    const idle = fakeSession(false);
    const streaming = fakeSession(true);

    await deliverPiAgentMessage(idle.session, "followUp", "review after");
    await deliverPiAgentMessage(streaming.session, "followUp", "review later");

    assert.deepEqual(idle.followUps, ["review after"]);
    assert.deepEqual(streaming.followUps, ["review later"]);
    assert.deepEqual(idle.calls, []);
    assert.deepEqual(streaming.calls, []);
});
