import assert from "node:assert/strict";
import test from "node:test";

import { createError, errorCodes } from "@portable-devshell/shared";

import {
    normalizeLifecycleStatus,
    parseWorkerStatus
} from "../../dist/worker/instance/WorkerInstanceStatus.js";
import {
    normalizeToolSchedulerError,
    readNonRunningSchedulerStatus,
    throwIfToolCallAborted
} from "../../dist/worker/instance/tool/WorkerInstanceToolError.js";
import {
    asBashToolResult,
    asCommandResult,
    commandResultOutput,
    readByteLength
} from "../../dist/worker/instance/tool/WorkerInstanceToolResult.js";

test("worker lifecycle status normalization maps ready to running and preserves terminal states", () => {
    assert.equal(normalizeLifecycleStatus("ready"), "running");
    assert.equal(normalizeLifecycleStatus("running"), "running");
    assert.equal(normalizeLifecycleStatus("stale"), "stale");
    assert.equal(normalizeLifecycleStatus("stopped"), "stopped");
    assert.equal(normalizeLifecycleStatus("failed"), "failed");
});

test("worker status parser accepts canonical status and ignores malformed optional metadata", () => {
    assert.deepEqual(
        parseWorkerStatus(
            JSON.stringify({
                pid: 1234,
                state: "running",
                workerSha256: "abc",
                workspace: "/workspace"
            }),
            "local-one"
        ),
        {
            daemonState: "running",
            pid: 1234,
            workerSha256: "abc",
            workspacePath: "/workspace"
        }
    );
    assert.deepEqual(
        parseWorkerStatus(JSON.stringify({ pid: "1234", state: "stopped", workspace: null }), "local-one"),
        {
            daemonState: "stopped",
            pid: undefined,
            workerSha256: undefined,
            workspacePath: undefined
        }
    );
});

test("worker status parser returns structured diagnostics for malformed and unknown payloads", () => {
    const largePayload = `${"x".repeat(5000)}TAIL`;
    assert.throws(
        () => parseWorkerStatus(largePayload, "local-one"),
        (error: unknown) => {
            assert.equal(readField(error, "code"), errorCodes.coreWorkerStatusFailed);
            const details = readField(error, "details") as Record<string, unknown>;
            assert.equal(details.instance, "local-one");
            assert.equal((details.stdoutTail as string).length, 4000);
            assert.match(details.stdoutTail as string, /TAIL$/u);
            return true;
        }
    );
    assert.throws(
        () => parseWorkerStatus("[]", "local-one"),
        (error: unknown) => readField(error, "code") === errorCodes.coreWorkerStatusFailed
    );
    assert.throws(
        () => parseWorkerStatus('{"state":"paused"}', "local-one"),
        (error: unknown) => {
            assert.equal(readField(error, "code"), errorCodes.coreWorkerStatusFailed);
            const details = readField(error, "details") as Record<string, unknown>;
            assert.equal(details.state, "paused");
            return true;
        }
    );
});

test("tool scheduler error classification covers queue timeout and both cancellation codes", () => {
    assert.equal(readNonRunningSchedulerStatus(errorCodes.coreToolQueueTimeout), "queueTimeout");
    assert.equal(readNonRunningSchedulerStatus(errorCodes.coreToolCallCancelled), "cancelled");
    assert.equal(readNonRunningSchedulerStatus("tool.cancelled"), "cancelled");
    assert.equal(readNonRunningSchedulerStatus(errorCodes.coreToolSchedulerFull), undefined);
});

test("tool scheduler normalization canonicalizes retryable scheduler failures and preserves other errors", () => {
    const cancelled = Object.assign(new Error("worker cancelled"), {
        code: "tool.cancelled",
        details: { operationId: "operation-1" }
    });
    const normalized = normalizeToolSchedulerError(cancelled);
    assert.notEqual(normalized, cancelled);
    assert.equal(readField(normalized, "code"), errorCodes.coreToolCallCancelled);
    assert.equal(readField(normalized, "retryable"), true);
    assert.deepEqual(readField(normalized, "details"), { operationId: "operation-1" });

    const full = createError({
        code: errorCodes.coreToolSchedulerFull,
        details: { queueDepth: 4 },
        message: "full",
        retryable: false
    });
    const normalizedFull = normalizeToolSchedulerError(full);
    assert.equal(readField(normalizedFull, "code"), errorCodes.coreToolSchedulerFull);
    assert.equal(readField(normalizedFull, "retryable"), true);

    const unrelated = new Error("unrelated");
    assert.equal(normalizeToolSchedulerError(unrelated), unrelated);
});

test("tool cancellation guard ignores active signals and reports client cancellation reasons", () => {
    throwIfToolCallAborted(undefined);
    const active = new AbortController();
    throwIfToolCallAborted(active.signal);

    const cancelled = new AbortController();
    cancelled.abort("user stopped");
    assert.throws(
        () => throwIfToolCallAborted(cancelled.signal),
        (error: unknown) => {
            assert.equal(readField(error, "code"), errorCodes.coreToolCallCancelled);
            assert.equal(readField(error, "retryable"), true);
            assert.deepEqual(readField(error, "details"), { reason: "user stopped" });
            return true;
        }
    );

    const generic = new AbortController();
    generic.abort(new Error("closed"));
    assert.throws(
        () => throwIfToolCallAborted(generic.signal),
        (error: unknown) => {
            assert.deepEqual(readField(error, "details"), { reason: "client cancelled" });
            return true;
        }
    );
});

test("command result extraction supports direct process fields and diagnostic-only failures", () => {
    assert.deepEqual(
        asCommandResult({
            details: {
                command: ["ssh", 2, "host"],
                cwd: "/workspace",
                exitCode: 7
            },
            exitCode: 7,
            signal: "SIGTERM",
            stderr: "failed",
            stdout: "partial",
            timedOut: true
        }),
        {
            details: {
                command: ["ssh", "host"],
                cwd: "/workspace",
                exitCode: 7
            },
            exitCode: 7,
            signal: "SIGTERM",
            stderr: "failed",
            stdout: "partial",
            timedOut: true
        }
    );
    assert.deepEqual(
        asCommandResult({
            details: {
                causeMessage: "spawn failed",
                exitCode: null,
                stderrTail: "missing binary"
            }
        }),
        {
            details: {
                causeMessage: "spawn failed",
                exitCode: null,
                stderrTail: "missing binary"
            },
            exitCode: null,
            signal: undefined,
            stderr: "",
            stdout: "",
            timedOut: false
        }
    );
    assert.equal(asCommandResult(null), undefined);
    assert.equal(asCommandResult({ details: { causeMessage: "no exit code" } }), undefined);
});

test("command and bash result serializers omit invalid optionals and calculate UTF-8 byte lengths", () => {
    assert.deepEqual(
        commandResultOutput({
            details: undefined,
            exitCode: 0,
            signal: undefined,
            stderr: "",
            stdout: "ok",
            timedOut: false
        }),
        {
            exitCode: 0,
            stderr: "",
            stdout: "ok",
            timedOut: false
        }
    );

    assert.deepEqual(
        asBashToolResult({
            exitCode: null,
            stderr: "错",
            stdout: "ok",
            termSignal: 9,
            termination: "signaled"
        }),
        {
            exitCode: null,
            stderr: "错",
            stderrBytes: 3,
            stdout: "ok",
            stdoutBytes: 2,
            termSignal: 9,
            termination: "signaled"
        }
    );
    assert.deepEqual(
        asBashToolResult({
            stderr: "",
            stderrBytes: 10,
            stdout: "x",
            stdoutBytes: 20,
            termination: "unknown"
        }),
        {
            stderr: "",
            stderrBytes: 10,
            stdout: "x",
            stdoutBytes: 20
        }
    );
    assert.equal(asBashToolResult("invalid"), undefined);
    assert.equal(asBashToolResult({ stderr: "", stdout: 1 }), undefined);
    assert.equal(readByteLength("前"), 3);
});

function readField(value: unknown, field: string): unknown {
    assert.equal(typeof value, "object");
    assert.notEqual(value, null);
    return (value as Record<string, unknown>)[field];
}
