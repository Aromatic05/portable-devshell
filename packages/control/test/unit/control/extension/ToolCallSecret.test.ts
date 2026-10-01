import assert from "node:assert/strict";
import test from "node:test";

import { secretRewriteInterfaceOperation } from "@portable-devshell/extension/secret";
import type { ToolCallRewriteInvocation } from "@portable-devshell/extension/toolcall";
import type { ControlConfig } from "@portable-devshell/shared";

import { ToolCallSecretRewrite } from "../../../../src/control/extension/toolcall/interface/Secret.ts";

const signal = new AbortController().signal;
const tokenReference = "$" + "{SECRET:TOKEN}";
const otherReference = "$" + "{SECRET:OTHER}";
const inbound: ToolCallRewriteInvocation = {
    callId: "call-secret",
    direction: "inbound",
    value: {
        context: {
            ctxId: "ctx-secret",
            instance: "demo",
            source: "mcp",
        },
        kind: "call",
        payload: "echo " + tokenReference,
        toolName: "bash_run",
    },
};
const outbound: ToolCallRewriteInvocation = {
    ...inbound,
    direction: "outbound",
    value: {
        ...inbound.value,
        kind: "result",
        payload: "result",
    },
};

function config(instances: Array<{ env?: Record<string, string>; name: string }>): ControlConfig {
    return { instances } as unknown as ControlConfig;
}

test("ToolCall Secret interface follows the current rewritten instance and exposes only names used by the scope", async () => {
    let current = config([
        { env: { TOKEN: "first" }, name: "demo" },
        { env: { TOKEN: "second", OTHER: "value" }, name: "other" },
    ]);
    const secret = new ToolCallSecretRewrite(() => current);
    const scope = secret.scope("secret");

    assert.deepEqual(
        await scope
            .context(inbound, signal)
            .requestInterface(secretRewriteInterfaceOperation, {
                names: ["TOKEN"],
            }),
        { TOKEN: "first" },
    );

    current = config([
        { env: { TOKEN: "changed" }, name: "demo" },
        { env: { TOKEN: "second", OTHER: "value" }, name: "other" },
    ]);
    assert.deepEqual(
        await scope
            .context(outbound, signal)
            .requestInterface(secretRewriteInterfaceOperation),
        { TOKEN: "changed" },
    );

    const otherInbound: ToolCallRewriteInvocation = {
        ...inbound,
        value: {
            ...inbound.value,
            context: { ...inbound.value.context, instance: "other" },
            payload: "echo " + otherReference,
        },
    };
    assert.deepEqual(
        await scope
            .context(otherInbound, signal)
            .requestInterface(secretRewriteInterfaceOperation, {
                names: ["OTHER"],
            }),
        { OTHER: "value" },
    );
});

test("ToolCall Secret interface rejects unsupported requests and names absent from the current value", async () => {
    const secret = new ToolCallSecretRewrite(() =>
        config([{ env: { TOKEN: "value", OTHER: "other" }, name: "demo" }]),
    );

    await assert.rejects(
        secret
            .scope("other")
            .context(inbound, signal)
            .requestInterface(secretRewriteInterfaceOperation, {
                names: ["TOKEN"],
            }),
        /Unsupported ToolCall rewrite interface operation/u,
    );
    await assert.rejects(
        secret
            .scope("secret")
            .context(inbound, signal)
            .requestInterface("secret.other"),
        /Unsupported ToolCall rewrite interface operation/u,
    );
    await assert.rejects(
        secret
            .scope("secret")
            .context(inbound, signal)
            .requestInterface(secretRewriteInterfaceOperation),
        /requires referenced secret names/u,
    );
    await assert.rejects(
        secret
            .scope("secret")
            .context(inbound, signal)
            .requestInterface(secretRewriteInterfaceOperation, {
                names: ["OTHER"],
            }),
        /not present in the current ToolCall payload/u,
    );
    await assert.rejects(
        secret
            .scope("secret")
            .context(outbound, signal)
            .requestInterface(secretRewriteInterfaceOperation, {
                names: ["TOKEN"],
            }),
        /outbound Secret rewrite does not accept input/u,
    );
});
