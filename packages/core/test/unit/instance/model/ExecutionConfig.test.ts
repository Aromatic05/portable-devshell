import assert from "node:assert/strict";
import test from "node:test";

import { normalizeConfigInstanceDraft } from "@portable-devshell/shared";

import { Instance, toWorkerConfig } from "../../../../src/instance/model/Instance.ts";
import { ReverseProvision } from "../../../../src/instance/runtime/provision/install/provider/Reverse.ts";

test("execution configuration reaches daemon startup through provider env", () => {
    const execution = {
        environment: [{ order: 3, name: "runtime", content: "export MODE=test" }],
        sandbox: { name: "limits", content: { enabled: true } },
    };
    const instance = normalizeConfigInstanceDraft({
        env: {
            DEVSHELL_WORKER_EXECUTION_CONFIG: "user value is ignored",
            DEVSHELL_WORKER_INTERNAL_SECURITY_MODE: "disabled",
        },
        execution,
        name: "execution-worker",
        provider: "local",
        security: { mode: "workspace" },
    });

    const worker = toWorkerConfig(instance, undefined, "/tmp/execution-worker");

    assert.equal(worker.env?.DEVSHELL_WORKER_EXECUTION_CONFIG, JSON.stringify(execution));
    assert.equal(worker.env?.DEVSHELL_WORKER_INTERNAL_SECURITY_MODE, "workspace");
});

test("unset execution configuration does not set the daemon startup env", () => {
    const instance = normalizeConfigInstanceDraft({
        env: { DEVSHELL_WORKER_EXECUTION_CONFIG: "user value is ignored" },
        name: "plain-worker",
        provider: "local",
    });

    const worker = toWorkerConfig(instance, undefined, "/tmp/plain-worker");

    assert.equal(worker.env?.DEVSHELL_WORKER_EXECUTION_CONFIG, undefined);
});

test("Instance resolves automatic environments when no execution config was set", async () => {
    let compile: (() => Promise<string | undefined>) | undefined;
    const instance = new Instance({
        commandClient: {
            setExecutionConfigResolver(resolve: () => Promise<string | undefined>) {
                compile = resolve;
            },
        },
        config: { name: "plain-worker" },
        eventLog: {},
        state: {},
        subscriptions: {},
        worker: {},
    } as never);
    let selection: unknown;
    instance.setExecutionConfigResolver(async (config) => {
        selection = config;
        return { environment: [{ order: 1, name: "direnv", content: {} }] };
    });
    assert.ok(compile);
    assert.deepEqual(selection, undefined);
    assert.deepEqual(JSON.parse((await compile())!), {
        environment: [{ order: 1, name: "direnv", content: {} }],
    });
    assert.deepEqual(selection, {});
});

test("reverse instances do not claim controller startup propagation", () => {
    const instance = normalizeConfigInstanceDraft({
        execution: {
            sandbox: { name: "policy", content: { enabled: true } },
        },
        name: "reverse-worker",
        provider: "reverse",
    });

    const worker = toWorkerConfig(instance, new ReverseProvision(), "/tmp/reverse-worker");

    assert.equal(worker.env?.DEVSHELL_WORKER_EXECUTION_CONFIG, undefined);
});
