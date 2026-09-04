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

test("bash_run truncation hint does not leak an artifact handle", () => {
    const hints = resolveResultHints("bash_run", {
        exitCode: 0,
        stderr: "", stderrBytes: 0, stderrTruncated: false,
        stdout: "", stdoutBytes: 0, stdoutTruncated: true,
        stdoutArtifact: { artifactTruncated: false, handle: "h1" },
        termination: "exited"
    });
    assert.deepEqual(codes(hints), ["bash.outputTruncated"]);
    assert.equal(hints[0].text.includes("h1"), false);
});

test("bash_run error hints cover invalid command and cancellation semantics", () => {
    assert.deepEqual(codes(resolveErrorHints("bash_run", body("bash.invalidCommand"))), ["bash.invalidCommand"]);
    assert.match(resolveErrorHints("bash_run", body("bash.invalidCwd"))[0]?.text ?? "", /\.\/.*workspace-relative/u);
    const cancelled = resolveErrorHints("bash_run", body("tool.cancelled"));
    assert.deepEqual(codes(cancelled), ["tool.cancelled"]);
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

test("file_edit snapshotRequired revisionMismatch and cancellation errors are classified", () => {
    assert.deepEqual(codes(resolveErrorHints("file_edit", body("file.snapshotRequired"))), ["file.snapshotRequired"]);
    assert.deepEqual(codes(resolveErrorHints("file_edit", body("file.revisionMismatch"))), ["file.revisionMismatch"]);
    const cancelled = resolveErrorHints("file_edit", body("tool.cancelled"));
    assert.deepEqual(codes(cancelled), ["tool.cancelled"]);
});

test("file_edit literal diff body is rejected with a scolding hint", () => {
    const hints = resolveErrorHints("file_edit", body("file.literalDiffBody"));
    assert.deepEqual(codes(hints), ["file.literalDiffBody"]);
    assert.match(hints[0]?.text ?? "", /literal content/u);
});

test("tmux_run block timeout keeps the task running and is not a failure", () => {
    const hints = resolveResultHints("tmux_run", {
        observationReset: false,
        output: [],
        task: { id: "t1", status: "running" },
        warnings: [{ code: "tmux.blockTimeout", message: "wait timed out" }]
    });
    assert.deepEqual(codes(hints), ["tmux.blockTimeout"]);
    assert.match(hints[0]?.text ?? "", /tmux_read/u);
});

test("tmux_run running task without block timeout yields a task-running diagnostic", () => {
    const hints = resolveResultHints("tmux_run", {
        observationReset: false,
        output: [],
        task: { id: "t1", status: "running" },
        warnings: []
    });
    assert.deepEqual(codes(hints), ["tmux.taskRunning"]);
    assert.match(hints[0]?.text ?? "", /tmux_read/u);
});

test("tmux_run detached handoff stays valid without Workspace recovery", () => {
    const hints = resolveResultHints("tmux_run", {
        detached: true,
        task: { id: "t1", status: "running" },
    });
    assert.deepEqual(codes(hints), ["tmux.runDetached"]);
    assert.match(hints[0]?.text ?? "", /returned task id/iu);
    assert.match(hints[0]?.text ?? "", /tmux_read/iu);
    assert.doesNotMatch(hints[0]?.text ?? "", /Workspace/iu);
});

test("tmux_read detached handoff stays valid without Workspace recovery", () => {
    const hints = resolveResultHints("tmux_read", {
        detached: true,
        task: { id: "t1", status: "running" },
    });
    assert.deepEqual(codes(hints), ["tmux.readDetached"]);
    assert.match(hints[0]?.text ?? "", /tmux_read/iu);
    assert.doesNotMatch(hints[0]?.text ?? "", /Workspace/iu);
});

test("tmux_run interrupted wait tells the model the task is still running", () => {
    const hints = resolveResultHints("tmux_run", {
        interrupted: true,
        task: { id: "t1", status: "running" },
    });
    assert.deepEqual(codes(hints), ["tmux.runInterrupted"]);
    assert.match(hints[0]?.text ?? "", /user stopped waiting/iu);
    assert.match(hints[0]?.text ?? "", /still running/iu);
});

test("tmux task terminal status distinguishes success, failure, and unknown", () => {
    assert.deepEqual(resolveResultHints("tmux_read", { task: { status: "0" }, warnings: [] }), []);
    assert.deepEqual(resolveResultHints("tmux_run", { task: { status: "0" } }), []);
    assert.deepEqual(codes(resolveResultHints("tmux_read", { task: { status: "3" }, warnings: [] })), ["tmux.taskFailed"]);
    assert.deepEqual(codes(resolveResultHints("tmux_read", { task: { status: "unknown" }, warnings: [] })), ["tmux.taskStatusUnknown"]);
});

test("tmux_run start-unconfirmed forbids an immediate relaunch", () => {
    const hints = resolveErrorHints("tmux_run", body("tmux.taskStartUnconfirmed"));
    assert.deepEqual(codes(hints), ["tmux.taskStartUnconfirmed"]);
});

test("tmux cwd errors explain the supported path namespaces", () => {
    assert.match(resolveErrorHints("tmux_create", body("tmux.invalidCwd"))[0]?.text ?? "", /\.\/.*workspace-relative/u);
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

    const interrupted = resolveResultHints("artifact_transfer", {
        operation: "status", transfer: { status: "interrupted", transferId: "x1" }
    });
    assert.deepEqual(codes(interrupted), ["artifact.transferInterrupted"]);

    const cancelled = resolveResultHints("artifact_transfer", {
        operation: "status", transfer: { status: "cancelled", transferId: "x1" }
    });
    assert.deepEqual(codes(cancelled), ["artifact.transferCancelled"]);

    const cancelCompleted = resolveResultHints("artifact_transfer", {
        operation: "cancel", transfer: { status: "completed", transferId: "x1" }
    });
    assert.deepEqual(codes(cancelCompleted), ["artifact.transferCancelCompleted"]);
});

test("instance already-exists and config-invalid use real catalog codes and safe fields", () => {
    const exists = resolveErrorHints("instance_create", body("control.instanceAlreadyExists"));
    assert.deepEqual(codes(exists), ["control.instanceAlreadyExists"]);
    const config = resolveErrorHints("instance_create", body("control.configInvalid", {
        details: { fieldPath: "ssh.port", issueCode: "outOfRange" }
    }));
    assert.deepEqual(codes(config), ["control.configInvalid"]);
    assert.match(config[0].text, /ssh\.port/);
    assert.match(config[0].text, /outOfRange/);
});

test("todo revision conflict and invalid invariants are classified", () => {
    assert.deepEqual(codes(resolveErrorHints("todo_write", body("todo.revisionConflict"))), ["todo.revisionConflict"]);
    const invalid = resolveErrorHints("todo_write", body("todo.invalid"));
    assert.deepEqual(codes(invalid), ["todo.invalid"]);
});

test("cross-tool error hints apply to any tool and walk the cause chain", () => {
    const denied = resolveErrorHints("bash_run", body("core.approvalDenied"));
    assert.deepEqual(codes(denied), ["core.approvalDenied"]);

    const wrapped = resolveErrorHints("instance_connect", body("core.workerStartFailed", {
        cause: { code: "core.providerFailed", message: "provider", retryable: true }
    }));
    assert.deepEqual(codes(wrapped), ["core.workerStartFailed", "core.providerFailed"]);
});

test("context expired, disabled, and invalid remain distinct error classes", () => {
    const expired = resolveErrorHints("bash_run", body("mcp.contextExpired"));
    assert.deepEqual(codes(expired), ["mcp.contextExpired"]);
    assert.match(expired[0]?.text ?? "", /environ_info with the same ctxId/u);
    const disabled = resolveErrorHints("bash_run", body("mcp.contextDisabled"));
    assert.deepEqual(codes(disabled), ["mcp.contextDisabled"]);
    assert.match(disabled[0]?.text ?? "", /environ_info with workspace without the disabled ctxId/u);
    const invalid = resolveErrorHints("bash_run", body("mcp.contextInvalid"));
    assert.deepEqual(codes(invalid), ["mcp.contextInvalid"]);
    assert.match(invalid[0]?.text ?? "", /ctxId returned by environ_info/u);
});

test("unclassified errors fall back to a safe unknown hint", () => {
    const hints = resolveErrorHints("bash_run", body("something.neverSeen"));
    assert.deepEqual(codes(hints), ["error.unknown"]);
});

test("merge keeps user comments first and deduplicates hint codes", () => {
    const hints = resolveResultHints("bash_run", {
        exitCode: 1, stderr: "", stderrBytes: 0, stderrTruncated: false,
        stdout: "", stdoutBytes: 0, stdoutTruncated: false, termination: "exited"
    });
    const merged = mergeComments(["user note"], [...hints, ...hints]);
    assert.equal(merged[0], "user note");
    assert.equal(merged.filter((entry) => entry.startsWith("[bash.nonZeroExit] ")).length, 1);
});
