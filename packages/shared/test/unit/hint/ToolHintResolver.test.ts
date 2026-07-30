import assert from "node:assert/strict";
import test from "node:test";

import {
    mergeComments,
    resolveErrorHints,
    resolveResultHints,
    type ToolDiagnosticHint
} from "@portable-devshell/shared";

function codes(hints: readonly ToolDiagnosticHint[]): string[] {
    return hints.map((hint) => hint.code);
}

function body(code: string, extra: Record<string, unknown> = {}): {
    code: string;
    message: string;
    retryable: boolean;
} & Record<string, unknown> {
    return { code, message: `${code} happened`, retryable: false, ...extra };
}

test("bash_run clean success produces no hint", () => {
    const hints = resolveResultHints("bash_run", {
        durationMs: 12,
        exitCode: 0,
        stderr: "",
        stderrBytes: 0,
        stderrTruncated: false,
        stdout: "ok",
        stdoutBytes: 2,
        stdoutTruncated: false,
        termination: "exited"
    });
    assert.deepEqual(hints, []);
});

test("bash_run non-zero exit yields a failure hint without leaking command or output", () => {
    const hints = resolveResultHints("bash_run", {
        durationMs: 12,
        exitCode: 7,
        stderr: "permission denied /secret/path",
        stderrBytes: 10,
        stderrTruncated: false,
        stdout: "secret-token=abc123",
        stdoutBytes: 10,
        stdoutTruncated: false,
        termination: "exited"
    });
    assert.deepEqual(codes(hints), ["bash.nonZeroExit"]);
    const text = hints[0].text;
    assert.match(text, /code 7/);
    for (const leak of ["permission denied", "/secret/path", "secret-token", "abc123"]) {
        assert.equal(text.includes(leak), false, `hint must not leak ${leak}`);
    }
});

test("bash_run timeout, signal, truncation, and artifact warnings each map to distinct hints", () => {
    assert.deepEqual(codes(resolveResultHints("bash_run", {
        stderr: "", stderrBytes: 0, stderrTruncated: false,
        stdout: "", stdoutBytes: 0, stdoutTruncated: false,
        termination: "timeout", timedOut: true
    })), ["bash.timeout"]);

    assert.deepEqual(codes(resolveResultHints("bash_run", {
        stderr: "", stderrBytes: 0, stderrTruncated: false,
        stdout: "", stdoutBytes: 0, stdoutTruncated: false,
        termSignal: 9, termination: "signaled"
    })), ["bash.signaled"]);

    assert.deepEqual(codes(resolveResultHints("bash_run", {
        exitCode: 0,
        stderr: "", stderrBytes: 0, stderrTruncated: true,
        stdout: "", stdoutBytes: 0, stdoutTruncated: true,
        termination: "exited"
    })), ["bash.outputTruncated"]);

    assert.deepEqual(codes(resolveResultHints("bash_run", {
        artifactWarnings: ["storage degraded"],
        exitCode: 0,
        stderr: "", stderrBytes: 0, stderrTruncated: false,
        stdout: "", stdoutBytes: 0, stdoutTruncated: false,
        termination: "exited"
    })), ["bash.artifactWarning"]);
});

test("bash_run truncation hint points at artifact_read when an artifact reference exists", () => {
    const hints = resolveResultHints("bash_run", {
        exitCode: 0,
        stderr: "", stderrBytes: 0, stderrTruncated: false,
        stdout: "", stdoutBytes: 0, stdoutTruncated: true,
        stdoutArtifact: { artifactTruncated: false, handle: "h1" },
        termination: "exited"
    });
    assert.deepEqual(codes(hints), ["bash.outputTruncated"]);
    assert.match(hints[0].text, /artifact_read/);
    assert.equal(hints[0].text.includes("h1"), false);
});

test("bash_run error hints cover invalid command and cancellation semantics", () => {
    assert.deepEqual(codes(resolveErrorHints("bash_run", body("bash.invalidCommand"))), ["bash.invalidCommand"]);
    const cancelled = resolveErrorHints("bash_run", body("tool.cancelled"));
    assert.deepEqual(codes(cancelled), ["tool.cancelled"]);
    assert.match(cancelled[0].text, /process group was terminated/);
});

test("artifact_read paging, lossy, and source truncation are diagnosed", () => {
    assert.deepEqual(codes(resolveResultHints("artifact_read", {
        artifactTruncated: false, eof: false, lossy: false, nextOffsetBytes: 100
    })), ["artifact.partialRead"]);

    assert.deepEqual(codes(resolveResultHints("artifact_read", {
        artifactTruncated: false, eof: true, lossy: true
    })), ["artifact.lossy"]);

    const truncated = resolveResultHints("artifact_read", {
        artifactTruncated: true, eof: true, lossy: false
    });
    assert.deepEqual(codes(truncated), ["artifact.sourceTruncated"]);
    assert.match(truncated[0].text, /do not try to recover/i);
});

test("artifact_read expired handle is an error hint", () => {
    assert.deepEqual(codes(resolveErrorHints("artifact_read", body("artifact.expired"))), ["artifact.expired"]);
});

test("file_read truncation and partial parse are diagnosed", () => {
    assert.deepEqual(codes(resolveResultHints("file_read", { parseStatus: "complete", truncated: true })), ["file.partialRead"]);
    assert.deepEqual(codes(resolveResultHints("file_read", { parseStatus: "partial", truncated: false })), ["file.partialParse"]);
    assert.deepEqual(resolveResultHints("file_read", { parseStatus: "complete", truncated: false }), []);
});

test("file_find and file_search paging is diagnosed but empty results are not failures", () => {
    assert.deepEqual(codes(resolveResultHints("file_find", { entries: [], nextCursor: "c1" })), ["file.partialResults"]);
    assert.deepEqual(resolveResultHints("file_find", { entries: [] }), []);
    assert.deepEqual(codes(resolveResultHints("file_search", { files: [], nextCursor: "c1" })), ["file.partialResults"]);
    assert.deepEqual(resolveResultHints("file_search", { files: [] }), []);
});

test("file_info exists=false is an observation, not a failure", () => {
    assert.deepEqual(resolveResultHints("file_info", { entries: [{ exists: false, path: "./missing" }] }), []);
});

test("file_edit partial failure reports applied, failed, and not-executed operations", () => {
    const hints = resolveResultHints("file_edit", {
        complete: false,
        operations: [
            { action: "write", addedLines: 1, index: 0, removedLines: 0, status: "applied", truncated: false },
            { action: "patch", error: { code: "file.revisionMismatch" }, index: 1, status: "failed", truncated: false },
            { action: "delete", index: 2, status: "notExecuted", truncated: false }
        ]
    });
    assert.deepEqual(codes(hints), ["file.partialEdit"]);
    const text = hints[0].text;
    assert.match(text, /operation #1/);
    assert.match(text, /file\.revisionMismatch/);
    assert.match(text, /1 earlier operation/);
    assert.match(text, /do not replay the entire original change set/i);
});

test("file_edit no-op patch and truncated diff are diagnosed on complete sets", () => {
    const noop = resolveResultHints("file_edit", {
        complete: true,
        operations: [{ action: "patch", addedLines: 0, index: 0, removedLines: 0, status: "applied", truncated: false }]
    });
    assert.deepEqual(codes(noop), ["file.noContentChange"]);

    const diffTruncated = resolveResultHints("file_edit", {
        complete: true,
        operations: [{ action: "write", addedLines: 5, index: 0, removedLines: 1, status: "applied", truncated: true }]
    });
    assert.deepEqual(codes(diffTruncated), ["file.diffTruncated"]);

    const move = resolveResultHints("file_edit", {
        complete: true,
        operations: [{ action: "move", addedLines: 0, index: 0, removedLines: 0, status: "applied", truncated: false }]
    });
    assert.deepEqual(move, []);
});

test("file_edit snapshotRequired and revisionMismatch errors are actionable", () => {
    assert.deepEqual(codes(resolveErrorHints("file_edit", body("file.snapshotRequired"))), ["file.snapshotRequired"]);
    assert.deepEqual(codes(resolveErrorHints("file_edit", body("file.revisionMismatch"))), ["file.revisionMismatch"]);
    const cancelled = resolveErrorHints("file_edit", body("tool.cancelled"));
    assert.match(cancelled[0].text, /earlier operations may already be applied/);
});

test("tmux_run block timeout keeps the task running and is not a failure", () => {
    const hints = resolveResultHints("tmux_run", {
        observationReset: false,
        output: [],
        task: { id: "t1", status: "running" },
        warnings: [{ code: "tmux.blockTimeout", message: "wait timed out" }]
    });
    assert.deepEqual(codes(hints), ["tmux.blockTimeout"]);
    assert.match(hints[0].text, /still running/);
});

test("tmux_run running task without block timeout yields a task-running diagnostic", () => {
    const hints = resolveResultHints("tmux_run", {
        observationReset: false,
        output: [],
        task: { id: "t1", status: "running" },
        warnings: []
    });
    assert.deepEqual(codes(hints), ["tmux.taskRunning"]);
});

test("tmux task terminal status distinguishes success, failure, and unknown", () => {
    assert.deepEqual(resolveResultHints("tmux_read", { task: { status: "0" }, warnings: [] }), []);
    assert.deepEqual(codes(resolveResultHints("tmux_read", { task: { status: "3" }, warnings: [] })), ["tmux.taskFailed"]);
    assert.deepEqual(codes(resolveResultHints("tmux_read", { task: { status: "unknown" }, warnings: [] })), ["tmux.taskStatusUnknown"]);
});

test("tmux_run start-unconfirmed forbids an immediate relaunch", () => {
    const hints = resolveErrorHints("tmux_run", body("tmux.taskStartUnconfirmed"));
    assert.deepEqual(codes(hints), ["tmux.taskStartUnconfirmed"]);
    assert.match(hints[0].text, /do not call tmux_run again immediately/i);
});

test("tmux cancellation keeps the task running for run but not for create", () => {
    const run = resolveErrorHints("tmux_run", body("tool.cancelled"));
    assert.match(run[0].text, /task keeps running/);
    const create = resolveErrorHints("tmux_create", body("tool.cancelled"));
    assert.match(create[0].text, /no lasting side effect/);
});

test("tmux_list full capacity is a diagnostic, not a list failure", () => {
    const hints = resolveResultHints("tmux_list", { capacity: { max: 4, used: 4 }, panes: [], warnings: [] });
    assert.deepEqual(codes(hints), ["tmux.capacityFull"]);
});

test("artifact_transfer queued is accepted but not completed", () => {
    const hints = resolveResultHints("artifact_transfer", {
        operation: "start",
        transfer: { status: "queued", transferId: "x1" }
    });
    assert.deepEqual(codes(hints), ["artifact.transferQueued"]);
    assert.match(hints[0].text, /has not completed/);
});

test("artifact_transfer non-terminal, terminal, and failure states are distinguished", () => {
    assert.deepEqual(codes(resolveResultHints("artifact_transfer", {
        operation: "status", transfer: { status: "transferring", transferId: "x1" }
    })), ["artifact.transferInProgress"]);

    assert.deepEqual(resolveResultHints("artifact_transfer", {
        operation: "status", transfer: { status: "completed", transferId: "x1" }
    }), []);

    const failed = resolveResultHints("artifact_transfer", {
        operation: "status",
        transfer: { failure: { code: "artifact.targetExists", message: "exists", retryable: false }, status: "failed", transferId: "x1" }
    });
    assert.deepEqual(codes(failed), ["artifact.targetExists"]);
    assert.match(failed[0].text, /do not set overwrite=true without explicit user authorization/i);

    assert.deepEqual(codes(resolveResultHints("artifact_transfer", {
        operation: "status", transfer: { status: "interrupted", transferId: "x1" }
    })), ["artifact.transferInterrupted"]);

    const cancelCompleted = resolveResultHints("artifact_transfer", {
        operation: "cancel", transfer: { status: "completed", transferId: "x1" }
    });
    assert.deepEqual(codes(cancelCompleted), ["artifact.transferCancelCompleted"]);
});

test("instance already-exists and config-invalid use real catalog codes and safe fields", () => {
    assert.deepEqual(codes(resolveErrorHints("instance_create", body("control.instanceAlreadyExists"))), ["control.instanceAlreadyExists"]);
    const config = resolveErrorHints("instance_create", body("control.configInvalid", {
        details: { fieldPath: "ssh.port", issueCode: "outOfRange" }
    }));
    assert.deepEqual(codes(config), ["control.configInvalid"]);
    assert.match(config[0].text, /ssh\.port/);
    assert.match(config[0].text, /outOfRange/);
});

test("todo revision conflict and invalid invariants are actionable", () => {
    assert.deepEqual(codes(resolveErrorHints("todo_write", body("todo.revisionConflict"))), ["todo.revisionConflict"]);
    const invalid = resolveErrorHints("todo_write", body("todo.invalid"));
    assert.match(invalid[0].text, /full replacement, not a patch/i);
});

test("cross-tool error hints apply to any tool and walk the cause chain", () => {
    const denied = resolveErrorHints("bash_run", body("core.approvalDenied"));
    assert.deepEqual(codes(denied), ["core.approvalDenied"]);

    const wrapped = resolveErrorHints("instance_start", body("core.workerStartFailed", {
        cause: { code: "core.providerFailed", message: "provider", retryable: true }
    }));
    assert.deepEqual(codes(wrapped), ["core.workerStartFailed", "core.providerFailed"]);
});

test("context expired and invalid produce distinct recovery instructions", () => {
    const expired = resolveErrorHints("bash_run", body("mcp.contextExpired"));
    assert.match(expired[0].text, /Call environ_info once/);
    const invalid = resolveErrorHints("bash_run", body("mcp.contextInvalid"));
    assert.match(invalid[0].text, /do not call environ_info yourself/);
});

test("unclassified errors fall back to a safe unknown hint", () => {
    const hints = resolveErrorHints("bash_run", body("something.neverSeen"));
    assert.deepEqual(codes(hints), ["error.unknown"]);
    assert.match(hints[0].text, /do not report completion or retry the same operation unchanged/);
});

test("merge keeps user comments first and deduplicates hint codes", () => {
    const hints = resolveResultHints("bash_run", {
        exitCode: 1, stderr: "", stderrBytes: 0, stderrTruncated: false,
        stdout: "", stdoutBytes: 0, stdoutTruncated: false, termination: "exited"
    });
    const merged = mergeComments(["user note"], [...hints, ...hints]);
    assert.equal(merged[0], "user note");
    assert.equal(merged.filter((entry) => entry.startsWith("Error hint [bash.nonZeroExit]")).length, 1);
});
