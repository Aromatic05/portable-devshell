import assert from "node:assert/strict";
import test from "node:test";

import { normalizeConfigInstanceDraft } from "@portable-devshell/shared";

import { toWorkerConfig } from "../../../../src/instance/model/Instance.ts";
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
