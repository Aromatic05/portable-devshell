import assert from "node:assert/strict";
import test from "node:test";
import { environment } from "@portable-devshell/extension/execution";
import { activate } from "../../src/builtin/index.ts";

test("direnv contributes a worker-local environment driver descriptor", () => {
    const registrations: unknown[] = [];
    activate({ register: (...args: unknown[]) => registrations.push(args) } as never);
    assert.deepEqual(registrations, [[environment, "direnv", { name: "direnv", version: 1, executable: "direnv", args: ["export", "json"] }]]);
});
