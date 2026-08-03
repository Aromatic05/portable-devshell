import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { asInstanceName } from "@portable-devshell/shared";

import { renderCliError } from "../../src/render/CliRenderError.ts";
import { renderControlStatus } from "../../src/render/control/CliRenderControlStatus.ts";
import { renderInstanceList } from "../../src/render/instance/CliRenderInstanceList.ts";
import { renderInstanceLogs } from "../../src/render/instance/CliRenderInstanceLogs.ts";
import { renderInstanceSnapshot } from "../../src/render/instance/CliRenderInstanceSnapshot.ts";
import { renderInstanceTodo } from "../../src/render/instance/CliRenderInstanceTodo.ts";
import { renderToolResult } from "../../src/render/tool/CliRenderToolResult.ts";

test("renderers format control, instance, and tool outputs", async () => {
    const statusFixturePath = fileURLToPath(new URL("../fixtures/cli-status-output.txt", import.meta.url));
    const expectedStatus = (await readFile(statusFixturePath, "utf8")).replaceAll("\r\n", "\n");

    assert.equal(renderControlStatus({ instanceCount: 1, pid: 42, running: true }), expectedStatus);
    assert.equal(
        renderInstanceList([{ mcpEnabled: true, name: "demo-local", snapshot: { ready: false, status: "stopped" } as never }]),
        "demo-local\tstopped\tready=false\n"
    );
    assert.equal(
        renderInstanceSnapshot({
            connectionState: "disconnected",
            daemonState: "stopped",
            lastSeq: 0,
            name: asInstanceName("demo-local"),
            ready: false,
            status: "stopped"
        }),
        "instance: demo-local\nstatus: stopped\nready: false\ndaemonState: stopped\nconnectionState: disconnected\nlastSeq: 0\nTodo: none\n"
    );
    assert.equal(
        renderInstanceSnapshot({
            connectionState: "failed",
            daemonState: "running",
            lastErrorCode: "core.workerHandshakeFailed",
            lastErrorMessage: "Worker handshake failed for instance demo-local.",
            lastSeq: 1,
            name: asInstanceName("demo-local"),
            ready: false,
            status: "failed"
        }),
        "instance: demo-local\nstatus: failed\nready: false\ndaemonState: running\nconnectionState: failed\nlastSeq: 1\nlastErrorCode: core.workerHandshakeFailed\nlastErrorMessage: Worker handshake failed for instance demo-local.\nTodo: none\n"
    );
    assert.equal(
        renderInstanceLogs([{ at: "", instanceName: "demo-local", message: "hello\n", seq: 1, stream: "stdout" }]),
        "[1] stdout hello\n"
    );
    assert.equal(renderToolResult({ exitCode: 0, stderr: "", stdout: "ok\n" }), "exitCode: 0\nstdout:\nok\n");
    assert.equal(
        renderToolResult({ kind: "list", panes: [] }),
        '{\n  "kind": "list",\n  "panes": []\n}\n'
    );
});

test("Todo renderer shows aggregate task summaries instead of reporting none", () => {
    assert.equal(
        renderInstanceTodo({
            items: [],
            revision: 0,
            summary: { completed: 0, total: 0 },
            tasks: [{
                completed: 0,
                currentItem: "Generate harmless connector calls",
                revision: 281,
                status: "in_progress",
                taskId: "task-1",
                title: "testspace connector activity",
                total: 3,
                updatedAt: "2026-08-03T11:30:33.157Z"
            }]
        }),
        "Tasks:\n● testspace connector activity [0/3] — Generate harmless connector calls\n"
    );
});

test("renderCliError suggests starting control when it is not running", () => {
    assert.equal(
        renderCliError({ code: "control.notRunning", message: "control server is not running." }),
        "control server is not running.\nRun: devshell start\n"
    );
});

test("renderCliError includes diagnostic summary and verbose cause chain", () => {
    const error = {
        causeBody: {
            code: "core.providerFailed",
            message: "ssh exited",
            retryable: false
        },
        code: "core.workerStartFailed",
        details: {
            commandDisplay: "ssh demo -- sh -lc pwd",
            cwd: "/missing/workspace",
            exitCode: 255,
            operation: "start",
            provider: "ssh",
            stderrTail: "No such file or directory\n"
        },
        message: "Worker start failed for instance demo-ssh."
    };

    assert.equal(
        renderCliError(error),
        "Worker start failed for instance demo-ssh.\nprovider: ssh\noperation: start\ncommand: ssh demo -- sh -lc pwd\ncwd: /missing/workspace\nexitCode: 255\nstderr:\nNo such file or directory\n"
    );
    assert.match(renderCliError(error, { verbose: true }), /details: \{/u);
    assert.match(renderCliError(error, { verbose: true }), /cause: \{/u);
});
