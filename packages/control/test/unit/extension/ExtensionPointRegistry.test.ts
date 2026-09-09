import assert from "node:assert/strict";
import test from "node:test";

import { ExtensionPointRegistry } from "../../../src/control/extension/host/generation/ExtensionPointRegistry.ts";

test("Extension Point registry rejects invalid and duplicate point identities", () => {
    assert.throws(
        () => new ExtensionPointRegistry([{
            id: "invalid",
            parseDeclaration: (value) => value,
            validateBinding() {}
        }]),
        /lowercase namespaced id/u
    );
    const definition = {
        id: "test.point",
        parseDeclaration: (value: { id: string }) => value,
        validateBinding() {}
    };
    assert.throws(
        () => new ExtensionPointRegistry([definition, definition]),
        /registered more than once/u
    );
});

test("Extension Point registry delegates declaration, binding, and resource validation to the owner", async () => {
    const events: string[] = [];
    const registry = new ExtensionPointRegistry([{
        id: "test.point",
        parseDeclaration(declaration) {
            events.push(`declaration:${declaration.id}`);
            return Object.freeze({ ...declaration, title: "Parsed" });
        },
        validateBinding(binding, context) {
            events.push(`binding:${context.extensionId}:${context.id}:${String(binding)}`);
        },
        async validateBindingResources(binding, context) {
            events.push(`resources:${context.codeDirectory}:${context.id}:${String(binding)}`);
        }
    }]);
    const context = {
        codeDirectory: "/extension/code",
        extensionId: "example",
        id: "entry"
    };

    assert.deepEqual(
        registry.parseDeclaration("test.point", { id: "entry" }, "example"),
        { id: "entry", title: "Parsed" }
    );
    registry.validateBinding("test.point", "handler", context);
    await registry.validateBindingResources("test.point", "handler", context);
    assert.deepEqual(events, [
        "declaration:entry",
        "binding:example:entry:handler",
        "resources:/extension/code:entry:handler"
    ]);
});

test("Extension Point registry rejects an unsupported point before owner validation", async () => {
    const registry = new ExtensionPointRegistry([]);
    assert.throws(
        () => registry.parseDeclaration("future.point", { id: "entry" }, "example"),
        /Extension example declares unsupported Extension Point future\.point/u
    );
    assert.throws(
        () => registry.validateBinding("future.point", {}, {
            codeDirectory: "/extension/code",
            extensionId: "example",
            id: "entry"
        }),
        /unsupported Extension Point future\.point/u
    );
    await assert.rejects(
        registry.validateBindingResources("future.point", {}, {
            codeDirectory: "/extension/code",
            extensionId: "example",
            id: "entry"
        }),
        /unsupported Extension Point future\.point/u
    );
});
