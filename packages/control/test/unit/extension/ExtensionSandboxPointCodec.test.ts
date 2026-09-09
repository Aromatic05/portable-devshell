import assert from "node:assert/strict";
import test from "node:test";

import { ExtensionSandboxPointCodecRegistry } from "../../../src/control/extension/host/generation/sandbox/ExtensionSandboxPointCodec.ts";

const context = Object.freeze({
    codeDirectory: "/extension/code",
    extensionId: "example",
    id: "entry",
    async requestInterface() { return undefined; }
});

test("Extension sandbox codec registry rejects invalid and duplicate point identities", () => {
    assert.throws(
        () => new ExtensionSandboxPointCodecRegistry([{
            describeBinding: () => null,
            id: "invalid",
            invokeBinding: () => undefined
        }]),
        /sandbox point id is invalid/u
    );
    const codec = {
        describeBinding: () => ({ kind: "test" }),
        id: "test.point",
        invokeBinding: () => undefined
    };
    assert.throws(
        () => new ExtensionSandboxPointCodecRegistry([codec, codec]),
        /registered more than once/u
    );
});

test("Extension sandbox codec registry delegates descriptor and invocation semantics", async () => {
    const events: string[] = [];
    const registry = new ExtensionSandboxPointCodecRegistry([{
        describeBinding(binding, owner) {
            events.push(`describe:${owner.extensionId}:${owner.id}:${String(binding)}`);
            return { kind: "test" };
        },
        id: "test.point",
        async invokeBinding(binding, input, signal, owner) {
            events.push(`invoke:${owner.extensionId}:${owner.id}:${String(binding)}:${String(input)}`);
            assert.equal(signal.aborted, false);
            return { ok: true };
        }
    }]);

    assert.deepEqual(registry.describeBinding("test.point", "handler", context), { kind: "test" });
    assert.deepEqual(
        await registry.invokeBinding("test.point", "handler", "input", new AbortController().signal, context),
        { ok: true }
    );
    assert.deepEqual(events, [
        "describe:example:entry:handler",
        "invoke:example:entry:handler:input"
    ]);
});

test("Extension sandbox codec registry rejects unsupported points", async () => {
    const registry = new ExtensionSandboxPointCodecRegistry([]);
    assert.throws(
        () => registry.describeBinding("future.point", {}, context),
        /cannot sandbox unsupported Extension Point future\.point/u
    );
    await assert.rejects(
        registry.invokeBinding("future.point", {}, undefined, new AbortController().signal, context),
        /cannot sandbox unsupported Extension Point future\.point/u
    );
});
