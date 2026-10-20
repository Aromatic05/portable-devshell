import assert from "node:assert/strict";
import test from "node:test";

import { resolveExecutionDrivers } from "../../../../src/extension/api/point/execution/index.ts";

test("Execution resolves ordered environment drivers and the single selected sandbox", async () => {
    const acquired: string[] = [];
    const released: string[] = [];
    const extensions = {
        async acquireRegistration(pointId: string, id: string) {
            acquired.push(pointId + "/" + id);
            return {
                extensionId: id,
                lease: { release: () => released.push(pointId + "/" + id) },
                registration: {
                    binding: {
                        name: id,
                        version: 1,
                        executable: id === "direnv" ? "direnv" : "/usr/bin/sandbox-driver",
                        args: id === "direnv" ? ["export", "json"] : [],
                    },
                },
            };
        },
    };

    const compiled = await resolveExecutionDrivers(extensions as never, {
        environment: [
            { order: 100, name: "variables", content: { set: { BASE: "1" } } },
            { order: 200, name: "direnv", content: { required: true } },
        ],
        sandbox: { name: "custom-sandbox", content: { args: ["--ro-bind", "/", "/"] } },
    });

    assert.deepEqual(acquired, [
        "execution.environment/direnv",
        "execution.sandbox/custom-sandbox",
    ]);
    assert.deepEqual(released, acquired);
    assert.equal(compiled.environment?.[0]?.name, "variables");
    assert.deepEqual((compiled.environment?.[1] as { driver?: unknown }).driver, {
        name: "direnv",
        version: 1,
        executable: "direnv",
        args: ["export", "json"],
    });
    assert.equal((compiled.sandbox as { driver?: { name?: string } }).driver?.name, "custom-sandbox");
});

test("Execution refuses a missing selected environment generation without affecting other hooks", async () => {
    await assert.rejects(
        resolveExecutionDrivers({
            acquireRegistration: async () => {
                throw new Error("provider disabled");
            },
        } as never, {
            environment: [{ order: 100, name: "custom", content: { enabled: true } }],
        }),
        /provider disabled/u,
    );
});

test("Execution resolves environment hooks in configured order and acquires only one sandbox", async () => {
    const acquired: string[] = [];
    const extensions = {
        async acquireRegistration(pointId: string, id: string) {
            acquired.push(`${pointId}/${id}`);
            return {
                registration: { binding: { name: id, version: 1, executable: id, args: [] } },
                lease: { release() {} },
            };
        },
    };
    const compiled = await resolveExecutionDrivers(extensions as never, {
        environment: [
            { order: 200, name: "second", content: {} },
            { order: 100, name: "first", content: {} },
        ],
        sandbox: { name: "bubblewrap", content: { args: ["--die-with-parent"] } },
    });
    assert.deepEqual(acquired, [
        "execution.environment/second",
        "execution.environment/first",
    ]);
    assert.deepEqual(compiled.environment?.map(({ name }) => name), ["second", "first"]);
    assert.equal((compiled.sandbox as { name: string }).name, "bubblewrap");
    assert.equal((compiled.sandbox as { driver?: unknown }).driver, undefined);
});

test("Execution releases a selected provider lease when its descriptor is invalid", async () => {
    let released = 0;
    await assert.rejects(resolveExecutionDrivers({
        acquireRegistration: async () => ({
            registration: { binding: { name: "spoofed", version: 1 } },
            lease: { release() { released += 1; } },
        }),
    } as never, { sandbox: { name: "chosen", content: {} } }), /invalid driver/u);
    assert.equal(released, 1);
});
