import assert from "node:assert/strict";
import test from "node:test";

import { secretRewriteInterfaceOperation } from "@portable-devshell/extension/secret";
import type { ToolCallRewriteInvocation } from "@portable-devshell/extension/toolcall";
import type { ControlConfig } from "@portable-devshell/shared";

import { ToolCallSecretRewrite } from "../../../../src/control/extension/toolcall/interface/Secret.ts";

const inbound: ToolCallRewriteInvocation = {
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
const outbound: ToolCallRewriteInvocation = {
    ...inbound,
    direction: "outbound",
    kind: "result",
    text: "result",
};

function config(env: Record<string, string>): ControlConfig {
    return {
        instances: [{ env, name: "demo" }],
    } as unknown as ControlConfig;
}

test("ToolCall Secret interface pins one env snapshot and exposes only names resolved in this Boundary lease", async () => {
    let current = config({ TOKEN: "first", NO_COLOR: "1" });
    const secret = new ToolCallSecretRewrite(() => current);
    const firstScope = secret.scope("secret", "demo");

    assert.deepEqual(
        await firstScope
            .context(inbound)
            .requestInterface(secretRewriteInterfaceOperation, {
                names: ["TOKEN"],
            }),
        { TOKEN: "first" },
    );
    current = config({ TOKEN: "second", OTHER: "value", NO_COLOR: "0" });
    assert.deepEqual(
        await firstScope
            .context(outbound)
            .requestInterface(secretRewriteInterfaceOperation),
        { TOKEN: "first" },
    );

    const nextScope = secret.scope("secret", "demo");
    const nextInbound = {
        ...inbound,
        text: "echo ${SECRET:OTHER}",
    } satisfies ToolCallRewriteInvocation;
    assert.deepEqual(
        await nextScope
            .context(nextInbound)
            .requestInterface(secretRewriteInterfaceOperation, {
                names: ["OTHER"],
            }),
        { OTHER: "value" },
    );
});

test("ToolCall Secret interface rejects other Extensions, wrong-direction requests, and names absent from the current leaf", async () => {
    const secret = new ToolCallSecretRewrite(() =>
        config({ TOKEN: "value", OTHER: "other" }),
    );

    await assert.rejects(
        secret
            .scope("other", "demo")
            .context(inbound)
            .requestInterface(secretRewriteInterfaceOperation, {
                names: ["TOKEN"],
            }),
        /Unsupported ToolCall rewrite interface operation/u,
    );
    await assert.rejects(
        secret
            .scope("secret", "demo")
            .context(inbound)
            .requestInterface("secret.other"),
        /Unsupported ToolCall rewrite interface operation/u,
    );
    await assert.rejects(
        secret
            .scope("secret", "demo")
            .context(inbound)
            .requestInterface(secretRewriteInterfaceOperation),
        /requires referenced secret names/u,
    );
    await assert.rejects(
        secret
            .scope("secret", "demo")
            .context(inbound)
            .requestInterface(secretRewriteInterfaceOperation, {
                names: ["OTHER"],
            }),
        /not present in the current ToolCall text/u,
    );
    await assert.rejects(
        secret
            .scope("secret", "demo")
            .context(outbound)
            .requestInterface(secretRewriteInterfaceOperation, {
                names: ["TOKEN"],
            }),
        /outbound Secret rewrite does not accept input/u,
    );
});
