import assert from "node:assert/strict";
import test from "node:test";

import { PiAgentWebServer } from "../../src/provider/pi/PiAgentWebServer.ts";
import type {
    PiModelRuntimeLike,
    PiSessionLike,
    PiSettingsManagerLike
} from "../../src/provider/pi/PiSdkLoader.ts";

test("Pi Agent WebUI controls one live session without exposing stored credentials", async () => {
    const prompts: Array<{ message: string; streamingBehavior?: "steer" | "followUp" }> = [];
    const apiKeys: string[] = [];
    let aborts = 0;
    let configured = false;
    let defaultProvider: string | undefined;
    let defaultModel: string | undefined;
    let defaultThinkingLevel: string | undefined;
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
        async setModel(model) {
            session.agent!.state!.model = model;
        },
        setThinkingLevel(level) {
            session.agent!.state!.thinkingLevel = level;
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        }
    };
    const modelRuntime: PiModelRuntimeLike = {
        async checkAuth(providerId) {
            return providerId === "test-provider" && configured
                ? { source: "auth.json", type: "api_key" }
                : undefined;
        },
        getModel(providerId, modelId) {
            return providerId === "test-provider" && modelId === "test-model"
                ? { id: "test-model", name: "Test Model", provider: "test-provider" }
                : undefined;
        },
        getModels() {
            return [{ id: "test-model", name: "Test Model", provider: "test-provider" }];
        },
        getProviders() {
            return [{ id: "test-provider", name: "Test Provider" }];
        },
        async login(_providerId, type, interaction) {
            assert.equal(type, "api_key");
            apiKeys.push(await interaction.prompt({ message: "API key", type: "secret" }));
            configured = true;
            return { type: "api_key" };
        },
        async logout() {
            configured = false;
        }
    };
    const settingsManager: PiSettingsManagerLike = {
        async flush() {},
        getDefaultModel: () => defaultModel,
        getDefaultProvider: () => defaultProvider,
        getDefaultThinkingLevel: () => defaultThinkingLevel,
        setDefaultModelAndProvider(provider, modelId) {
            defaultProvider = provider;
            defaultModel = modelId;
        },
        setDefaultThinkingLevel(level) {
            defaultThinkingLevel = level;
        }
    };
    const server = new PiAgentWebServer({ modelRuntime, session, settingsManager });
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

        const initialConfig = await fetchJson(new URL("api/config", upstream)) as {
            providers: Array<{ auth: unknown }>;
        };
        assert.equal(initialConfig.providers[0]?.auth, null);

        const authConfig = await postJson(upstream, "api/auth/api-key", {
            key: "super-secret-test-key",
            provider: "test-provider"
        }) as { providers: Array<{ auth: { type: string } | null }> };
        assert.deepEqual(apiKeys, ["super-secret-test-key"]);
        assert.deepEqual(authConfig.providers[0]?.auth, { source: "auth.json", type: "api_key" });
        assert.equal(JSON.stringify(authConfig).includes("super-secret-test-key"), false);

        await postJson(upstream, "api/model", {
            modelId: "test-model",
            provider: "test-provider",
            thinkingLevel: "high"
        });
        assert.equal(defaultProvider, "test-provider");
        assert.equal(defaultModel, "test-model");
        assert.equal(defaultThinkingLevel, "high");
        assert.equal(session.agent?.state?.thinkingLevel, "high");

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

        await postJson(upstream, "api/auth/logout", { provider: "test-provider" });
        assert.equal(configured, false);

        const eventsAbort = new AbortController();
        const eventsResponse = await fetch(new URL("api/events", upstream), { signal: eventsAbort.signal });
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

async function postJson(upstream: URL, path: string, value: object): Promise<unknown> {
    const response = await fetch(new URL(path, upstream), {
        body: JSON.stringify(value),
        headers: { "content-type": "application/json" },
        method: "POST"
    });
    assert.equal(response.status, 200);
    return await response.json();
}

async function fetchJson(url: URL): Promise<unknown> {
    const response = await fetch(url);
    assert.equal(response.status, 200);
    return await response.json();
}
