import assert from "node:assert/strict";
import { join } from "node:path";

import {
    assertControlLog,
    assertOutput,
    createAcceptanceFixture,
    readAuditCollections,
    runCli
} from "./AcceptanceSupport.mjs";

const fixture = await createAcceptanceFixture();
try {
    const started = runCli(["start"], fixture.env);
    process.stdout.write(started.stdout);
    assertOutput(started, /control: running/u, "control did not start");

    const status = runCli(["status"], fixture.env);
    process.stdout.write(status.stdout);
    assertOutput(status, /instances: 1/u, "control did not load the instance");

    const listed = runCli(["instance", "list"], fixture.env);
    process.stdout.write(listed.stdout);
    assertOutput(listed, /aromatic-pc/u, "instance list omitted aromatic-pc");

    const before = runCli(["instance", "status", "aromatic-pc"], fixture.env);
    process.stdout.write(before.stdout);
    assertOutput(before, /status: stopped/u, "instance was not initially stopped");

    const instanceStarted = runCli(["instance", "start", "aromatic-pc"], fixture.env);
    process.stdout.write(instanceStarted.stdout);
    assertOutput(instanceStarted, /status: ready/u, "instance did not become ready");

    const after = runCli(["instance", "status", "aromatic-pc"], fixture.env);
    process.stdout.write(after.stdout);
    assertOutput(after, /ready: true/u, "ready state was not reported");

    const pwd = runCli(["instance", "call", "aromatic-pc", "bash_run", JSON.stringify({ command: "pwd" })], fixture.env);
    process.stdout.write(pwd.stdout);
    assert.equal(pwd.stdout.includes(fixture.workspace), true, "pwd output omitted the workspace");

    const echo = runCli([
        "instance",
        "call",
        "aromatic-pc",
        "bash_run",
        JSON.stringify({ command: "echo portable-devshell" })
    ], fixture.env);
    process.stdout.write(echo.stdout);
    assertOutput(echo, /portable-devshell/u, "echo output was not returned");

    const logs = runCli(["instance", "logs", "aromatic-pc"], fixture.env);
    process.stdout.write(logs.stdout);
    assertOutput(logs, /portable-devshell/u, "instance logs omitted tool output");

    const auditDatabase = join(
        fixture.home,
        ".devshell",
        "aromatic-pc",
        "control-worker",
        "audit.sqlite3"
    );
    const rows = readAuditCollections(auditDatabase);
    assert.equal(rows.some((row) => row.collection === "toolCalls" && row.payload.includes('"toolName":"bash_run"')), true);
    assert.equal(rows.some((row) => row.collection === "events" && row.payload.includes('"type":"toolCall.completed"')), true);
    assert.equal(rows.some((row) => row.collection === "logs" && row.payload.includes("portable-devshell")), true);
    await assertControlLog(fixture.home);

    runCli(["instance", "stop", "aromatic-pc"], fixture.env);
    const stopped = runCli(["stop"], fixture.env);
    process.stdout.write(stopped.stdout);
    assertOutput(stopped, /control: stopped/u, "control did not stop");
} finally {
    await fixture.cleanup();
}
