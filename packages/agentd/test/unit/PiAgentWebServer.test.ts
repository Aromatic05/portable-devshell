import assert from "node:assert/strict";
import test from "node:test";

import { PiAgentWebServer } from "../../src/provider/pi/PiAgentWebServer.ts";
import type { PiSessionLike } from "../../src/provider/pi/PiSdkLoader.ts";

test("Pi Agent WebUI reads live session state and controls the same Pi session", async () => {
    const prompts: Array<{ message: string; streamingBehavior?: "steer" | "followUp" }> = [];
    let aborts = 0;
    const listeners = new Set<(event: unknown) => void>();
    const session: PiSessionLike = {
        agent: {
            state: {
                isStreaming: false,
                messages: [
                    { role: "user", content: "inspect this repo" },
                    { role: "assistant", content: [{ type: "text", text: "working" }] }
                ],
                model: { id: "test-model", provider: "test-provider" },
                thinkingLevel: "medium"
            }
        },
        async abort() {
            aborts += 1;
        },
        dispose() {},
        async prompt(message, options) {
            prompts.push({
                message,
                ...(options?.streamingBehavior === undefined
                    ? {}
                    : { streamingBehavior: options.streamingBehavior })
            });
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        }
    };
    const server = new PiAgentWebServer(session);
    const upstream = await server.start();

    try {
        const stateResponse = await fetch(new URL("api/state", upstream));
        assert.equal(stateResponse.status, 200);
        assert.match(stateResponse.headers.get("content-security-policy") ?? "", /default-src 'self'/u);
        const state = await stateResponse.json() as {
            isStreaming: boolean;
            messages: Array<{ role: string }>;
            model: { id: string; provider: string };
            thinkingLevel: string;
        };
        assert.equal(state.isStreaming, false);
        assert.deepEqual(state.messages.map((message) => message.role), ["user", "assistant"]);
        assert.deepEqual(state.model, { id: "test-model", name: null, provider: "test-provider" });
        assert.equal(state.thinkingLevel, "medium");

        await postMessage(upstream, "api/prompt", "first");
        await postMessage(upstream, "api/steer", "redirect");
        await postMessage(upstream, "api/follow-up", "next");
        const abortResponse = await fetch(new URL("api/abort", upstream), { method: "POST" });
        assert.equal(abortResponse.status, 200);

        assert.deepEqual(prompts, [
            { message: "first" },
            { message: "redirect", streamingBehavior: "steer" },
            { message: "next", streamingBehavior: "followUp" }
        ]);
        assert.equal(aborts, 1);

        const eventsAbort = new AbortController();
        const events = fetch(new URL("api/events", upstream), { signal: eventsAbort.signal });
        const eventsResponse = await events;
        assert.equal(eventsResponse.status, 200);
        assert.equal(listeners.size, 1);
        listeners.forEach((listener) => listener({ type: "message_update" }));
        eventsAbort.abort();
        await eventsResponse.body?.cancel().catch(() => undefined);
    } finally {
        await server.stop();
    }
    assert.equal(listeners.size, 0);
});

async function postMessage(upstream: URL, path: string, message: string): Promise<void> {
    const response = await fetch(new URL(path, upstream), {
        body: JSON.stringify({ message }),
        headers: { "content-type": "application/json" },
        method: "POST"
    });
    assert.equal(response.status, 200);
}
