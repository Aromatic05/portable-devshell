import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { renderCliError } from "../../dist/cli/render/CliRenderError.js";
import { renderControlStatus } from "../../dist/cli/render/control/CliRenderControlStatus.js";
import { renderInstanceList } from "../../dist/cli/render/instance/CliRenderInstanceList.js";
import { renderInstanceLogs } from "../../dist/cli/render/instance/CliRenderInstanceLogs.js";
import { renderInstanceSnapshot } from "../../dist/cli/render/instance/CliRenderInstanceSnapshot.js";
import { renderToolResult } from "../../dist/cli/render/tool/CliRenderToolResult.js";

test("renderers format control, instance, and tool outputs", async () => {
    const statusFixturePath = fileURLToPath(new URL("../fixtures/cli-status-output.txt", import.meta.url));
    const expectedStatus = await readFile(statusFixturePath, "utf8");

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
            name: "demo-local",
            ready: false,
            status: "stopped"
        }),
        "instance: demo-local\nstatus: stopped\nready: false\ndaemonState: stopped\nconnectionState: disconnected\nlastSeq: 0\nTodo: none\n"
    );
    assert.equal(
        renderInstanceLogs([{ at: "", instanceName: "demo-local", message: "hello\n", seq: 1, stream: "stdout" }]),
        "[1] stdout hello\n"
    );
    assert.equal(renderToolResult({ exitCode: 0, stderr: "", stdout: "ok\n" }), "exitCode: 0\nstdout:\nok\n");
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
