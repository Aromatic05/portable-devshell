import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
    ConfigDomainController,
    ConfigDomainStore,
    ConfigRegistry,
    ControlConfigMutationLock,
} from "../../../../src/testing.ts";
import { setConfigPathValue } from "../../../../src/control/config/Path.ts";
import { createTestTempDirectory } from "../../../../../../test/TestTempDirectory.ts";

const schema = {
    additionalProperties: false,
    properties: {
        enabled: { type: "boolean" },
        name: { type: "string" },
    },
    required: ["enabled"],
    type: "object",
};

function definition(generation: string) {
    return {
        defaultValue: { enabled: false },
        id: "example",
        owner: {
            extensionId: "example",
            generation,
            kind: "extension" as const,
        },
        schema,
    };
}

test("Config registry validates schema defaults and replaces one Extension owner across generations", () => {
    const registry = new ConfigRegistry([definition("gen-a")]);

    assert.deepEqual(registry.require("example").defaultValue, {
        enabled: false,
    });
    registry.replace({
        ...definition("gen-b"),
        defaultValue: { enabled: true, name: "new" },
    });
    assert.deepEqual(registry.require("example").owner, {
        extensionId: "example",
        generation: "gen-b",
        kind: "extension",
    });
    assert.throws(
        () =>
            registry.replace({
                ...definition("gen-c"),
                defaultValue: { name: "missing-required-field" },
            }),
        /defaultValue does not match/u,
    );
});

test("Config path writes never traverse inherited objects", () => {
    const inherited = { nested: { polluted: false } };
    const root = Object.create(inherited) as Record<string, never>;

    setConfigPathValue(root, ["nested", "polluted"], true);

    assert.equal(inherited.nested.polluted, false);
    assert.deepEqual(root.nested, { polluted: true });
    assert.equal(Object.hasOwn(root, "nested"), true);
});

test("Config domain controller reads defaults, persists atomically, validates writes, and fences stale generations", async () => {
    const directory = await createTestTempDirectory("config-domain");
    const filePath = join(directory, "config.json");
    const registry = new ConfigRegistry([definition("gen-a")]);
    const mutationRunner = new ControlConfigMutationLock();
    const controller = new ConfigDomainController({
        definition: definition("gen-a"),
        mutationRunner,
        registry,
        store: new ConfigDomainStore(filePath),
    });

    try {
        assert.deepEqual(await controller.read(), { enabled: false });
        assert.deepEqual(
            await controller.write({ enabled: true, name: "saved" }),
            { enabled: true, name: "saved" },
        );
        assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), {
            enabled: true,
            name: "saved",
        });
        if (process.platform !== "win32")
            assert.equal((await stat(filePath)).mode & 0o777, 0o600);

        await assert.rejects(
            async () => await controller.write({ enabled: "yes" } as never),
            /value does not match/u,
        );

        registry.replace(definition("gen-b"));
        assert.deepEqual(await controller.read(), {
            enabled: true,
            name: "saved",
        });
        await assert.rejects(
            async () => await controller.write({ enabled: false }),
            /not writable/u,
        );

        const replacement = new ConfigDomainController({
            definition: definition("gen-b"),
            mutationRunner,
            registry,
            store: new ConfigDomainStore(filePath),
        });
        assert.deepEqual(await replacement.read(), {
            enabled: true,
            name: "saved",
        });
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
});
