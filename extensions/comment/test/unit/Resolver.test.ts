import assert from "node:assert/strict";
import test from "node:test";

import { mergeComments } from "../../src/comment/Merge.ts";
import type { ToolDiagnosticHint } from "../../src/hint/Hint.ts";
import { resolveErrorHints, resolveResultHints } from "../../src/hint/Resolver.ts";

function codes(hints: readonly ToolDiagnosticHint[]): string[] {
    return hints.map((hint) => hint.code);
}

function body(
    code: string,
    extra: Record<string, unknown> = {},
): {
    code: string;
    message: string;
    retryable: boolean;
} & Record<string, unknown> {
    return { code, message: `${code} happened`, retryable: false, ...extra };
}

test("a failed task directs the model to the task, not to restart the host", () => {
    const hints = resolveErrorHints("task_input", body("process.taskFailed"));
    assert.deepEqual(codes(hints), ["process.taskFailed"]);
    assert.match(hints[0].text, /target process failed.*do not restart the Process Host/u);
});

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
        termination: "exited",
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
        termination: "exited",
    });
    assert.deepEqual(codes(hints), ["bash.nonZeroExit"]);
    const text = hints[0].text;
    assert.match(text, /code 7/);
    for (const leak of [
        "permission denied",
        "/secret/path",
        "secret-token",
        "abc123",
    ]) {
        assert.equal(text.includes(leak), false, `hint must not leak ${leak}`);
    }
});

test("bash_run timeout, signal, truncation, and artifact warnings each map to distinct hints", () => {
    assert.deepEqual(
        codes(
            resolveResultHints("bash_run", {
                stderr: "",
                stderrBytes: 0,
                stderrTruncated: false,
                stdout: "",
                stdoutBytes: 0,
                stdoutTruncated: false,
                termination: "timeout",
                timedOut: true,
            }),
        ),
        ["bash.timeout"],
    );

    assert.deepEqual(
        codes(
            resolveResultHints("bash_run", {
                stderr: "",
                stderrBytes: 0,
                stderrTruncated: false,
                stdout: "",
                stdoutBytes: 0,
                stdoutTruncated: false,
                termSignal: 9,
                termination: "signaled",
            }),
        ),
        ["bash.signaled"],
    );

    assert.deepEqual(
        codes(
            resolveResultHints("bash_run", {
                exitCode: 0,
                stderr: "",
                stderrBytes: 0,
                stderrTruncated: true,
                stdout: "",
                stdoutBytes: 0,
                stdoutTruncated: true,
                termination: "exited",
            }),
        ),
        ["bash.outputTruncated"],
    );

    assert.deepEqual(
        codes(
            resolveResultHints("bash_run", {
                artifactWarnings: ["storage degraded"],
                exitCode: 0,
                stderr: "",
                stderrBytes: 0,
                stderrTruncated: false,
                stdout: "",
                stdoutBytes: 0,
                stdoutTruncated: false,
                termination: "exited",
            }),
        ),
        ["bash.artifactWarning"],
    );
});

test("bash_run truncation hint does not leak an artifact handle", () => {
    const hints = resolveResultHints("bash_run", {
        exitCode: 0,
        stderr: "",
        stderrBytes: 0,
        stderrTruncated: false,
        stdout: "",
        stdoutBytes: 0,
        stdoutTruncated: true,
        stdoutArtifact: { artifactTruncated: false, handle: "h1" },
        termination: "exited",
    });
    assert.deepEqual(codes(hints), ["bash.outputTruncated"]);
    assert.equal(hints[0].text.includes("h1"), false);
});

test("bash_run error hints cover invalid command and cancellation semantics", () => {
    assert.deepEqual(
        codes(resolveErrorHints("bash_run", body("bash.invalidCommand"))),
        ["bash.invalidCommand"],
    );
    assert.deepEqual(
        codes(resolveErrorHints("bash_run", body("bash.invalidCwd"))),
        ["bash.invalidCwd"],
    );
    const cancelled = resolveErrorHints("bash_run", body("tool.cancelled"));
    assert.deepEqual(codes(cancelled), ["tool.cancelled"]);
});

test("file_read truncation and partial parse are diagnosed", () => {
    assert.deepEqual(
        codes(
            resolveResultHints("file_read", {
                parseStatus: "complete",
                truncated: true,
            }),
        ),
        ["file.partialRead"],
    );
    assert.deepEqual(
        codes(
            resolveResultHints("file_read", {
                parseStatus: "partial",
                truncated: false,
            }),
        ),
        ["file.partialParse"],
    );
    assert.deepEqual(
        codes(
            resolveResultHints("file_read", {
                files: [
                    { nextSelector: "201", path: "./a.ts", view: "content" },
                ],
            }),
        ),
        ["file.partialRead"],
    );
    assert.deepEqual(
        resolveResultHints("file_read", {
            parseStatus: "complete",
            truncated: false,
        }),
        [],
    );
});

test("file_glob and file_grep paging is diagnosed but empty results are not failures", () => {
    assert.deepEqual(
        codes(
            resolveResultHints("file_glob", { entries: [], nextCursor: "c1" }),
        ),
        ["file.partialResults"],
    );
    assert.deepEqual(resolveResultHints("file_glob", { entries: [] }), []);
    assert.deepEqual(
        codes(resolveResultHints("file_grep", { files: [], nextCursor: "c1" })),
        ["file.partialResults"],
    );
    assert.deepEqual(resolveResultHints("file_grep", { files: [] }), []);
});

test("file_grep reports exact-file nextLine independently of traversal cursor", () => {
    const singleFile = resolveResultHints("file_grep", {
        files: [{ path: "example.ts", nextLine: 81 }],
    });
    assert.deepEqual(codes(singleFile), ["file.partialFileResults"]);
    assert.match(singleFile[0]?.text ?? "", /startLine/u);
    assert.deepEqual(codes(resolveResultHints("file_grep", {
        files: [{ path: "example.ts", nextLine: 81 }],
        nextCursor: "c2",
    })), ["file.partialFileResults", "file.partialResults"]);
});

test("file_read metadata missing paths are observations, not failures", () => {
    assert.deepEqual(
        resolveResultHints("file_read", {
            files: [
                {
                    metadata: { exists: false },
                    path: "./missing",
                    view: "metadata",
                },
            ],
        }),
        [],
    );
});

test("file_edit partial failure reports applied, failed, and not-executed operations", () => {
    const hints = resolveResultHints("file_edit", {
        complete: false,
        operations: [
            {
                action: "write",
                addedLines: 1,
                index: 0,
                removedLines: 0,
                status: "applied",
                truncated: false,
            },
            {
                action: "patch",
                error: { code: "file.revisionMismatch" },
                index: 1,
                status: "failed",
                truncated: false,
            },
            {
                action: "delete",
                index: 2,
                status: "notExecuted",
                truncated: false,
            },
        ],
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
        operations: [
            {
                action: "patch",
                addedLines: 0,
                index: 0,
                removedLines: 0,
                status: "applied",
                truncated: false,
            },
        ],
    });
    assert.deepEqual(codes(noop), ["file.noContentChange"]);

    const diffTruncated = resolveResultHints("file_edit", {
        complete: true,
        operations: [
            {
                action: "write",
                addedLines: 5,
                index: 0,
                removedLines: 1,
                status: "applied",
                truncated: true,
            },
        ],
    });
    assert.deepEqual(codes(diffTruncated), ["file.diffTruncated"]);

    const move = resolveResultHints("file_edit", {
        complete: true,
        operations: [
            {
                action: "move",
                addedLines: 0,
                index: 0,
                removedLines: 0,
                status: "applied",
                truncated: false,
            },
        ],
    });
    assert.deepEqual(move, []);
});

test("file_edit snapshotRequired revisionMismatch and cancellation errors are classified", () => {
    assert.deepEqual(
        codes(resolveErrorHints("file_edit", body("file.snapshotRequired"))),
        ["file.snapshotRequired"],
    );
    assert.deepEqual(
        codes(resolveErrorHints("file_edit", body("file.revisionMismatch"))),
        ["file.revisionMismatch"],
    );
    const cancelled = resolveErrorHints("file_edit", body("tool.cancelled"));
    assert.deepEqual(codes(cancelled), ["tool.cancelled"]);
});

test("file_edit literal diff body is rejected with a scolding hint", () => {
    const hints = resolveErrorHints("file_edit", body("file.literalDiffBody"));
    assert.deepEqual(codes(hints), ["file.literalDiffBody"]);
    assert.match(hints[0]?.text ?? "", /literal content/u);
});

test("bash_run soft wait returns a running task without treating it as failure", () => {
    const hints = resolveResultHints("bash_run", {
        termination: "running",
        waitReason: "timeout",
        waitMs: 250,
        task: { id: "t1", status: "running" },
    });
    assert.deepEqual(codes(hints), ["bash.taskRunning"]);
    assert.match(hints[0]?.text ?? "", /task_input/u);
});

test("bash_run durable handoff directs the model to the independent task cursor", () => {
    const hints = resolveResultHints("bash_run", {
        detached: true,
        termination: "running",
        task: { id: "t1", status: "running" },
        cursor: "4",
    });
    assert.deepEqual(codes(hints), ["bash.waitDetached"]);
    assert.match(hints[0]?.text ?? "", /task_input/u);
    assert.match(hints[0]?.text ?? "", /cursor/u);
});

test("task_input running result uses the same task continuation guidance", () => {
    const hints = resolveResultHints("task_input", {
        termination: "running",
        waitReason: "timeout",
        task: { id: "t1", status: "running" },
    });
    assert.deepEqual(codes(hints), ["bash.taskRunning"]);
    assert.match(hints[0]?.text ?? "", /task_input/u);
});

test("Process Host errors have task-specific recovery guidance", () => {
    assert.deepEqual(
        codes(resolveErrorHints("task_input", body("process.controlOwned"))),
        ["process.controlOwned"],
    );
    assert.deepEqual(
        codes(resolveErrorHints("task_input", body("process.notFound"))),
        ["process.notFound"],
    );
    assert.deepEqual(
        codes(resolveErrorHints("task_manage", body("process.resourceLimit"))),
        ["process.resourceLimit"],
    );
    const notTerminal = resolveErrorHints("task_input", body("process.notTerminal"));
    assert.deepEqual(codes(notTerminal), ["process.notTerminal"]);
    assert.match(notTerminal[0]?.text ?? "", /task_input without input/u);
    const stdinClosed = resolveErrorHints("task_input", body("process.stdinClosed"));
    assert.deepEqual(codes(stdinClosed), ["process.stdinClosed"]);
    assert.match(stdinClosed[0]?.text ?? "", /pty: true/u);
    assert.deepEqual(
        codes(resolveErrorHints("task_input", body("process.notPipe"))),
        ["process.notPipe"],
    );
    const exited = resolveErrorHints("task_input", body("process.exited"));
    assert.deepEqual(codes(exited), ["process.exited"]);
    assert.match(exited[0]?.text ?? "", /already exited/u);
    assert.deepEqual(
        codes(resolveErrorHints("task_manage", body("tool.invalidArguments"))),
        ["tool.invalidArguments"],
    );
    assert.deepEqual(
        codes(resolveErrorHints("task_input", body("tool.cancelled"))),
        ["tool.cancelled"],
    );
    const closePending = resolveResultHints("task_manage", {
        taskId: "process-1",
        killRequested: true,
        state: "running",
    });
    assert.deepEqual(codes(closePending), ["process.closePending"]);
    assert.match(closePending[0]?.text ?? "", /task_manage\(command: "list"\)/u);
    assert.deepEqual(
        resolveResultHints("task_manage", {
            taskId: "process-1",
            killRequested: true,
            state: "exited",
        }),
        [],
    );
});

test("task_input uses the shared Bash result status for successful and failed tasks", () => {
    assert.deepEqual(
        resolveResultHints("task_input", {
            task: { status: "0" },
            exitCode: 0,
            termination: "exited",
            stdout: "ok",
            stderr: "",
        }),
        [],
    );
    const failed = resolveResultHints("task_input", {
        task: { status: "3" },
        exitCode: 3,
        termination: "exited",
        stdout: "",
        stderr: "failure",
    });
    assert.deepEqual(codes(failed), ["bash.nonZeroExit"]);
});

test("instance already-exists and config-invalid use real catalog codes and safe fields", () => {
    const exists = resolveErrorHints(
        "instance_create",
        body("control.instanceAlreadyExists"),
    );
    assert.deepEqual(codes(exists), ["control.instanceAlreadyExists"]);
    const config = resolveErrorHints(
        "instance_create",
        body("control.configInvalid", {
            details: { fieldPath: "ssh.port", issueCode: "outOfRange" },
        }),
    );
    assert.deepEqual(codes(config), ["control.configInvalid"]);
    assert.match(config[0].text, /ssh\.port/);
    assert.match(config[0].text, /outOfRange/);
});

test("cross-tool error hints apply to any tool and walk the cause chain", () => {
    const denied = resolveErrorHints("bash_run", body("core.approvalDenied"));
    assert.deepEqual(codes(denied), ["core.approvalDenied"]);

    const wrapped = resolveErrorHints(
        "bash_run",
        body("core.workerStartFailed", {
            cause: {
                code: "core.providerFailed",
                message: "provider",
                retryable: true,
            },
        }),
    );
    assert.deepEqual(codes(wrapped), [
        "core.workerStartFailed",
        "core.providerFailed",
    ]);
});

test("message control errors use dedicated cross-tool guidance", () => {
    const stopped = resolveErrorHints(
        "bash_run",
        body("control.modelStopped"),
    );
    assert.deepEqual(codes(stopped), ["control.modelStopped"]);
    assert.match(stopped[0]?.text ?? "", /#resume/u);
    assert.doesNotMatch(stopped[0]?.text ?? "", /resubmit the full plan/u);

    const pushed = resolveErrorHints(
        "file_read",
        body("control.modelReplyRequired"),
    );
    assert.deepEqual(codes(pushed), ["control.modelReplyRequired"]);
    assert.match(pushed[0]?.text ?? "", /progress_report/u);

    const resumed = resolveErrorHints("bash_run", body("control.modelResumed"));
    assert.deepEqual(codes(resumed), ["control.modelResumed"]);
    assert.match(resumed[0]?.text ?? "", /resumed user instruction/u);
});

test("context expired, disabled, and invalid remain distinct error classes", () => {
    const expired = resolveErrorHints("bash_run", body("mcp.contextExpired"));
    assert.deepEqual(codes(expired), ["mcp.contextExpired"]);
    assert.match(
        expired[0]?.text ?? "",
        /Call environ_info to renew the current Context/u,
    );
    const disabled = resolveErrorHints("bash_run", body("mcp.contextDisabled"));
    assert.deepEqual(codes(disabled), ["mcp.contextDisabled"]);
    assert.match(
        disabled[0]?.text ?? "",
        /ask the user for its absolute path/u,
    );
    const invalid = resolveErrorHints("bash_run", body("mcp.contextInvalid"));
    assert.deepEqual(codes(invalid), ["mcp.contextInvalid"]);
    assert.match(
        invalid[0]?.text ?? "",
        /ask the user for its absolute path/u,
    );
    const invalidTarget = resolveErrorHints("environ_remote", body("control.invalidTarget"));
    assert.deepEqual(codes(invalidTarget), ["control.invalidTarget"]);
    assert.match(invalidTarget[0]?.text ?? "", /invalid argument or target/u);
});

test("unclassified errors fall back to a safe unknown hint", () => {
    const hints = resolveErrorHints("bash_run", body("something.neverSeen"));
    assert.deepEqual(codes(hints), ["error.unknown"]);
});

test("merge keeps user comments first and deduplicates hint codes", () => {
    const hints = resolveResultHints("bash_run", {
        exitCode: 1,
        stderr: "",
        stderrBytes: 0,
        stderrTruncated: false,
        stdout: "",
        stdoutBytes: 0,
        stdoutTruncated: false,
        termination: "exited",
    });
    const merged = mergeComments(["user note"], [...hints, ...hints]);
    assert.equal(merged[0], "user note");
    assert.equal(
        merged.filter((entry) => entry.startsWith("[bash.nonZeroExit] "))
            .length,
        1,
    );
});
