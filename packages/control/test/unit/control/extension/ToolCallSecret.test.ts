import assert from "node:assert/strict";
import test from "node:test";

import { secretRewriteInterfaceOperation } from "@portable-devshell/extension/secret";
import type { ToolCallRewriteInvocation } from "@portable-devshell/extension/toolcall";
import type { ControlConfig } from "@portable-devshell/shared";

import { ToolCallSecretRewrite } from "../../../../src/control/extension/toolcall/interface/Secret.ts";

const input: ToolCallRewriteInvocation = {
    context: {
        ctxId: "ctx-secret",
        instance: "demo",
        source: "mcp",
    },
    direction: "inbound",
    kind: "call",
    path: ["command"],
    signal: new AbortController().signal,
    text: "echo ${SECRET:TOKEN}",
    toolName: "bash_run",
};

function config(env: Record<string, string>): ControlConfig {
    return {
        instances: [{ env, name: "demo" }],
    } as unknown as ControlConfig;
}

test("ToolCall Secret interface pins one env snapshot per Boundary lease and refreshes the next lease", async () => {
    let current = config({ TOKEN: "first" });
    const secret = new ToolCallSecretRewrite(() => current);
    const firstScope = secret.scope("secret", "demo");
    const firstContext = firstScope.context(input);

    assert.deepEqual(
        await firstContext.requestInterface(secretRewriteInterfaceOperation),
        { TOKEN: "first" },
    );
    current = config({ TOKEN: "second", OTHER: "value" });
    assert.deepEqual(
        await firstContext.requestInterface(secretRewriteInterfaceOperation),
        { TOKEN: "first" },
    );
    const nextContext = secret.scope("secret", "demo").context(input);
    assert.deepEqual(
        await nextContext.requestInterface(secretRewriteInterfaceOperation),
        { OTHER: "value", TOKEN: "second" },
    );
});

test("ToolCall Secret interface rejects other Extensions, operations, and Extension-selected input", async () => {
    const secret = new ToolCallSecretRewrite(() => config({ TOKEN: "value" }));

    await assert.rejects(
        secret
            .scope("other", "demo")
            .context(input)
            .requestInterface(secretRewriteInterfaceOperation),
        /Unsupported ToolCall rewrite interface operation/u,
    );
    await assert.rejects(
        secret
            .scope("secret", "demo")
            .context(input)
            .requestInterface("secret.other"),
        /Unsupported ToolCall rewrite interface operation/u,
    );
    await assert.rejects(
        secret
            .scope("secret", "demo")
            .context(input)
            .requestInterface(secretRewriteInterfaceOperation, {
                instance: "other",
            }),
        /does not accept Extension-provided input/u,
    );
});
