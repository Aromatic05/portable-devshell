import assert from "node:assert/strict";
import test from "node:test";

import { executeInstanceLifecycle } from "../../src/command/instance/lifecycle/Command.js";

test("Round5 delete forwards the exact instance and returns provider result", async () => {
    const calls: string[] = [];
    const output: unknown[] = [];
    await executeInstanceLifecycle({ kind: "instance.delete", instance: "remote-one" }, {
        clients: { instance: { async deleteInstance(name: string) {
            calls.push(name);
            return { deleted: true, cleanup: "complete" };
        } } },
        writeJson(value: unknown) { output.push(value); },
    } as never);
    assert.deepEqual(calls, ["remote-one"]);
    assert.deepEqual(output, [{ deleted: true, cleanup: "complete" }]);
});

test("Round5 delete provider failure is propagated without false success output", async () => {
    const output: unknown[] = [];
    const failure = { code: "provider.unreachable", message: "SSH host refused connection" };
    await assert.rejects(executeInstanceLifecycle({ kind: "instance.delete", instance: "ssh-one" }, {
        clients: { instance: { async deleteInstance() { throw failure; } } },
        writeJson(value: unknown) { output.push(value); },
    } as never), (error) => error === failure);
    assert.deepEqual(output, []);
});

test("Round5 cleanup listing displays outstanding debt without attempting retry", async () => {
    const calls: string[] = [];
    const output: unknown[] = [];
    const debts = [{ instance: "podman-old", generationId: "gen-7", state: "orphaned", guidance: "Remove container manually" }];
    await executeInstanceLifecycle({ kind: "instance.cleanup.list" }, {
        clients: { instance: {
            async listCleanupDebts() { calls.push("list"); return debts; },
            async retryCleanupDebt() { calls.push("retry"); return []; },
        } },
        writeJson(value: unknown) { output.push(value); },
    } as never);
    assert.deepEqual(calls, ["list"]);
    assert.deepEqual(output, [debts]);
});

test("Round5 cleanup retry scopes work to the requested instance and prints result", async () => {
    const calls: string[] = [];
    const output: unknown[] = [];
    const result = [{ instance: "podman-old", generationId: "gen-7", state: "cleaned" }];
    await executeInstanceLifecycle({ kind: "instance.cleanup.retry", instance: "podman-old" }, {
        clients: { instance: { async retryCleanupDebt(name: string) { calls.push(name); return result; } } },
        writeJson(value: unknown) { output.push(value); },
    } as never);
    assert.deepEqual(calls, ["podman-old"]);
    assert.deepEqual(output, [result]);
});

test("Round5 cleanup retry provider error remains a failure and emits no success", async () => {
    const output: unknown[] = [];
    const failure = new Error("container runtime unavailable");
    await assert.rejects(executeInstanceLifecycle({ kind: "instance.cleanup.retry", instance: "podman-old" }, {
        clients: { instance: { async retryCleanupDebt() { throw failure; } } },
        writeJson(value: unknown) { output.push(value); },
    } as never), (error) => error === failure);
    assert.deepEqual(output, []);
});

test("Round5 reverse code command prints expiration metadata returned by Control", async () => {
    const output: Array<{ value: unknown; text: string }> = [];
    const code = { instance: "reverse-one", controllerUrl: "https://control.invalid", deviceCode: "one-time", expiresAt: "2030-01-01T00:00:00.000Z" };
    await executeInstanceLifecycle({ kind: "instance.deviceCode", instance: "reverse-one" }, {
        clients: { reverse: { async createCode(name: string) { assert.equal(name, "reverse-one"); return code; } } },
        writeValue(value: unknown, text: string) { output.push({ value, text }); },
    } as never);
    assert.deepEqual(output, [{ value: code, text: `instance: ${code.instance}\ndevice code: ${code.deviceCode}\nexpires: ${code.expiresAt}\nenroll: devshell-worker enroll --controller ${code.controllerUrl} --device-code ${code.deviceCode}\nIf this code expires, rerun: devshell instance device-code ${code.instance}\n` }]);
});

test("Round5 stale reverse credentials reject without printing a replacement code", async () => {
    const output: unknown[] = [];
    const failure = { code: "reverse.instanceNotFound", message: "Instance credential is stale" };
    await assert.rejects(executeInstanceLifecycle({ kind: "instance.deviceCode", instance: "reverse-one" }, {
        clients: { reverse: { async createCode() { throw failure; } } },
        writeValue(value: unknown) { output.push(value); },
    } as never), (error) => error === failure);
    assert.deepEqual(output, []);
});

test("Round5 token rotation provider error cannot appear as successful rotation", async () => {
    const output: unknown[] = [];
    const failure = new Error("credential store is locked");
    await assert.rejects(executeInstanceLifecycle({ kind: "instance.rotateToken", instance: "reverse-one" }, {
        clients: { reverse: { async rotateToken() { throw failure; } } },
        writeValue(value: unknown) { output.push(value); },
    } as never), (error) => error === failure);
    assert.deepEqual(output, []);
});
