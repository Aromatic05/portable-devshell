import assert from "node:assert/strict";
import test from "node:test";

import { createSecretRewrite } from "../../src/rewrite/SecretRewrite.ts";

const signal = new AbortController().signal;

function invocation(
    direction: "inbound" | "outbound",
    text: string,
) {
    return {
        context: {
            ctxId: "ctx-secret",
            instance: "demo",
            source: "mcp" as const,
        },
        direction,
        kind: direction === "inbound" ? ("call" as const) : ("result" as const),
        path: ["text"],
        signal,
        text,
        toolName: "bash_run",
    };
}

function rewriteContext(environment: Record<string, string>) {
    const calls: unknown[] = [];
    return {
        calls,
        context: {
            async requestInterface(operation: string, input?: unknown) {
                calls.push({ input, operation });
                return environment;
            },
        },
    };
}

test("Secret rewrite expands current-instance env references only on inbound text", async () => {
    const rewrite = createSecretRewrite();
    const host = rewriteContext({
        GITHUB_TOKEN: "real-github-token",
        OPENAI_API_KEY: "real-openai-key",
    });

    assert.equal(
        await rewrite(
            invocation(
                "inbound",
                "curl -H 'Token: ${SECRET:GITHUB_TOKEN}' --key ${SECRET:OPENAI_API_KEY}",
            ),
            host.context,
        ),
        "curl -H 'Token: real-github-token' --key real-openai-key",
    );
    assert.deepEqual(host.calls, [
        { input: undefined, operation: "secret.environment" },
    ]);
});

test("Secret rewrite masks every configured non-empty env value on outbound text and preserves existing references", async () => {
    const rewrite = createSecretRewrite();
    const host = rewriteContext({
        LONG: "token-value",
        SHORT: "token",
        EMPTY: "",
    });

    assert.equal(
        await rewrite(
            invocation(
                "outbound",
                "token-value token ${SECRET:SHORT} token-value",
            ),
            host.context,
        ),
        "${SECRET:LONG} ${SECRET:SHORT} ${SECRET:SHORT} ${SECRET:LONG}",
    );
});

test("Secret rewrite picks a deterministic canonical key when multiple env names share one value", async () => {
    const rewrite = createSecretRewrite();
    const host = rewriteContext({ Z_TOKEN: "same-value", A_TOKEN: "same-value" });

    assert.equal(
        await rewrite(
            invocation("outbound", "same-value"),
            host.context,
        ),
        "${SECRET:A_TOKEN}",
    );
});

test("Secret rewrite rejects an inbound reference missing from the current instance env", async () => {
    const rewrite = createSecretRewrite();
    const host = rewriteContext({ GITHUB_TOKEN: "real-github-token" });

    await assert.rejects(
        async () =>
            await rewrite(
                invocation("inbound", "echo ${SECRET:MISSING}"),
                host.context,
            ),
        /Secret MISSING is not configured in instance demo env/u,
    );
});
