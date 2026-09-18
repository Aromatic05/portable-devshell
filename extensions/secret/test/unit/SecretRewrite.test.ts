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
    const used = new Set<string>();
    return {
        calls,
        context: {
            async requestInterface(operation: string, input?: unknown) {
                calls.push({ input, operation });
                if (input !== undefined) {
                    const names = (input as { names: string[] }).names;
                    const selected: Record<string, string> = {};
                    for (const name of names) {
                        const value = environment[name];
                        if (value === undefined) continue;
                        selected[name] = value;
                        used.add(name);
                    }
                    return selected;
                }
                return Object.fromEntries(
                    [...used]
                        .filter((name) => environment[name] !== undefined)
                        .map((name) => [name, environment[name]!]),
                );
            },
        },
    };
}

test("Secret rewrite requests and expands only references present in inbound text", async () => {
    const rewrite = createSecretRewrite();
    const host = rewriteContext({
        GITHUB_TOKEN: "real-github-token",
        OPENAI_API_KEY: "real-openai-key",
        NO_COLOR: "1",
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
        {
            input: { names: ["GITHUB_TOKEN", "OPENAI_API_KEY"] },
            operation: "secret.environment",
        },
    ]);
});

test("Secret rewrite masks only secrets resolved inbound and leaves ordinary env values untouched", async () => {
    const rewrite = createSecretRewrite();
    const host = rewriteContext({
        LONG: "token-value",
        SHORT: "token",
        NO_COLOR: "1",
        LANG: "C",
    });

    assert.equal(
        await rewrite(
            invocation("inbound", "echo ${SECRET:LONG} ${SECRET:SHORT}"),
            host.context,
        ),
        "echo token-value token",
    );
    assert.equal(
        await rewrite(
            invocation(
                "outbound",
                "1 C token-value token ${SECRET:SHORT} token-value",
            ),
            host.context,
        ),
        "1 C ${SECRET:LONG} ${SECRET:SHORT} ${SECRET:SHORT} ${SECRET:LONG}",
    );
});

test("Secret rewrite picks a deterministic canonical key when referenced env names share one value", async () => {
    const rewrite = createSecretRewrite();
    const host = rewriteContext({ Z_TOKEN: "same-value", A_TOKEN: "same-value" });

    await rewrite(
        invocation("inbound", "${SECRET:Z_TOKEN} ${SECRET:A_TOKEN}"),
        host.context,
    );
    assert.equal(
        await rewrite(invocation("outbound", "same-value"), host.context),
        "${SECRET:A_TOKEN}",
    );
});

test("Secret rewrite does not let an unknown placeholder shield a resolved raw secret", async () => {
    const rewrite = createSecretRewrite();
    const host = rewriteContext({ TOKEN: "real-token" });

    await rewrite(invocation("inbound", "echo ${SECRET:TOKEN}"), host.context);
    const result = await rewrite(
        invocation("outbound", "${SECRET:real-token} real-token"),
        host.context,
    );
    assert.equal(result.includes("real-token"), false);
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
