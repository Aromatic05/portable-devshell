import assert from "node:assert/strict";
import test from "node:test";
import { asInstanceName, type ToolCallQuery, type ToolCallRecord } from "@portable-devshell/shared";
import { projectMcpAppActivity, readMcpAppActivity, readMcpAppActivityImage, readMcpAppActivityOutput } from "../../src/mcpapp/Activity.ts";

function call(id: string, ctxId: string, toolName: string, index: number,
    fields: Partial<ToolCallRecord> = {}): ToolCallRecord {
    return {
        callId: id, ctxId, toolName, status: "completed", source: "mcp",
        instance: asInstanceName("demo"), inputSummary: "", startedAt: new Date(index * 1_000).toISOString(),
        ...fields,
    };
}

test("Workspace history projects useful cards for every audited tool, isolating the Context and secrets", () => {
    const items = [
        call("a", "ctx-target", "bash_run", 1, { input: { command: "printf ok" }, purpose: "Check shell",
            exitCode: 0, output: { exitCode: 0, stdout: "ok\n" } }),
        call("b", "ctx-other", "file_read", 2, { output: { files: [{ content: "not yours" }] } }),
        call("c", "ctx-target", "file_read", 3, { input: { files: [{ path: "/etc/os-release" }] },
            output: { files: [{ path: "/etc/os-release", content: "1:NAME=Arch Linux\n2:ID=arch" }] } }),
        call("d", "ctx-target", "custom_plugin", 4, { input: { target: "remote-machine" },
            output: { result: { private_key: "must-not-display", ok: true } } }),
        call("e", "ctx-target", "tmux_run", 5, { status: "running", input: { command: "pnpm build" } }),
    ];
    const cards = projectMcpAppActivity(items, "ctx-target");
    assert.deepEqual(cards.map((item) => item.name), ["tmux_run", "custom_plugin", "file_read", "bash_run"]);
    assert.equal(cards[0]?.state, "running");
    assert.equal(cards[0]?.target, "pnpm build");
    assert.match(cards[2]?.detail ?? "", /1:NAME=Arch Linux\n2:ID=arch/u);
    assert.equal(cards[3]?.purpose, "Check shell");
    assert.equal(cards[3]?.summary, "exit 0");
    assert.match(cards[1]?.detail ?? "", /\[redacted\]/u);
    assert.equal(JSON.stringify(cards).includes("not yours"), false);
    assert.equal(JSON.stringify(cards).includes("must-not-display"), false);
});

test("Workspace history queries audited active and completed calls, with bounded-output fallback", async () => {
    const requested: ToolCallQuery[] = [];
    const cards = await readMcpAppActivity({
        listCalls: async (query) => {
            requested.push(query ?? {});
            if (query?.includeOutput) throw new Error("Oversized audit response");
            return [call("a", "ctx-target", "file_edit", 1, { status: "failed", error: "Invalid patch" }),
                call("b", "ctx-other", "secret_read", 2)];
        },
    }, "ctx-target");
    assert.equal(requested.length, 2);
    assert.equal(requested[0]?.ctxId, "ctx-target");
    assert.equal(requested[0]?.includeOutput, true);
    assert.equal(requested[1]?.includeOutput, false);
    assert.deepEqual(cards.map((item) => item.name), ["file_edit"]);
    assert.equal(cards[0]?.state, "failed");
    assert.match(cards[0]?.summary ?? "", /Invalid patch/u);
});

test("Tmux transcript polls share Task ID with the original command and stay audited", () => {
    const cards = projectMcpAppActivity([
        call("run", "ctx", "tmux_run", 1, {
            input: { command: "pnpm build" },
            output: { task: { id: "task-42", status: "running" } },
        }),
        call("poll", "ctx", "tmux_read", 2, {
            input: { task: "task-42", line: -30 },
            output: { task: { id: "task-42", status: "running" }, output: ["building..."] },
        }),
    ], "ctx");
    assert.equal(cards.length, 2);
    assert.deepEqual(cards.map((item) => item.taskId), ["task-42", "task-42"]);
    assert.equal(cards[0]?.name, "tmux_read");
});

test("Workspace audit projection preserves semantic operations within bounds and never exposes credentials", () => {
    const records = [
        call("edit", "ctx-a", "file_edit", 4, {
            input: { changes: "*** Begin Edit\n*** Patch File: ./src/index.ts\n" },
            output: { operations: [{
                path: "./src/index.ts", action: "patch", status: "applied", addedLines: 3,
                removedLines: 1, diff: "@@\n-old\n+new",
            }] },
        }),
        call("todo", "ctx-a", "todo_write", 5, {
            input: { title: "UI", token: "never-expose", nested: { password: "hidden" } },
            output: { title: "UI", items: [{ content: "Render", status: "completed" }],
                credential: "not-for-widget" },
        }),
        call("bash", "ctx-a", "bash_run", 6, {
            input: { command: "printf ok", purpose: "Check status" },
            output: { stdout: "ok", stderr: "", exitCode: 0 },
        }),
        call("other", "ctx-b", "file_read", 7, { output: { files: [{ content: "foreign" }] } }),
    ];
    const activity = projectMcpAppActivity(records, "ctx-a");
    assert.equal(activity.length, 3);
    const diff = activity.find((item) => item.name === "file_edit");
    const editOutput = diff?.output as { operations: Array<{ diff: string }> };
    assert.equal(editOutput.operations[0]?.diff, "@@\n-old\n+new");
    const todo = activity.find((item) => item.name === "todo_write");
    assert.equal((todo?.output as { items: Array<{ status: string }> }).items[0]?.status, "completed");
    const text = JSON.stringify(activity);
    assert.doesNotMatch(text, /never-expose|hidden|not-for-widget|foreign/u);
    assert.match(text, /\[redacted\]/u);
    const longResult = projectMcpAppActivity([
        call("long", "ctx-a", "bash_run", 8, { output: { stdout: "s".repeat(50_000) } }),
    ], "ctx-a");
    assert.ok(JSON.stringify(longResult[0]?.output).length <= 8_200);
});

test("Activity resolves stored images only from completed image ToolCalls in the owning Context", async () => {
    const queries: unknown[] = [];
    const imageRefs: string[] = [];
    let audited = call("image-call", "ctx-own", "artifact_viewImage", 1, {
        output: { imageRef: "stored.png", name: "map.png", bytes: 68 },
    });
    const tools = { listCalls: async (query: unknown) => {
        queries.push(query);
        return [audited];
    } };
    const artifacts = { readImage: async (imageRef: string) => {
        imageRefs.push(imageRef);
        return { imageRef, blake3: "hash", bytes: 68, mediaType: "image/png" as const,
            content: "aGVsbG8=", encoding: "base64" as const };
    } };
    const image = await readMcpAppActivityImage(tools, artifacts, "ctx-own", "image-call");
    assert.equal(image?.imageRef, "stored.png");
    assert.deepEqual(queries, [{
        ctxId: "ctx-own", callIds: ["image-call"], limit: 1,
        includeInput: false, includeOutput: true, maxBytes: 64 * 1024,
    }]);
    assert.deepEqual(imageRefs, ["stored.png"]);
    for (const foreign of [
        call("image-call", "ctx-other", "artifact_viewImage", 1,
            { output: { imageRef: "foreign.png" } }),
        call("image-call", "ctx-own", "file_read", 1,
            { output: { imageRef: "not-an-image.png" } }),
        call("image-call", "ctx-own", "artifact_viewImage", 1,
            { status: "running", output: { imageRef: "not-completed.png" } }),
        call("different-call", "ctx-own", "artifact_viewImage", 1,
            { output: { imageRef: "another-call.png" } }),
    ]) {
        audited = foreign;
        assert.equal(await readMcpAppActivityImage(tools, artifacts, "ctx-own", "image-call"), undefined);
    }
    assert.deepEqual(imageRefs, ["stored.png"]);
});

test("Activity restores retained stdout/stderr for only the owning Context and masks secrets", async () => {
    const tool = call("call-shell", "ctx-own", "bash_run", 1, {
        output: { exitCode: 0, stdoutBytes: 32, stderrBytes: 5 },
    });
    const queries: unknown[] = [];
    const output = await readMcpAppActivityOutput({
        listCalls: async (query) => {
            queries.push(query);
            return [tool];
        },
    }, {
        readLogs: async (query) => {
            queries.push(query);
            return [
                { at: "", seq: 1, instanceName: "demo", callId: "call-shell", ctxId: "ctx-own",
                    message: "ready\ntoken=example-credential\n", stream: "stdout" },
                { at: "", seq: 2, instanceName: "demo", callId: "call-shell", ctxId: "ctx-other",
                    message: "foreign log", stream: "stdout" },
                { at: "", seq: 3, instanceName: "demo", callId: "call-shell", ctxId: "ctx-own",
                    message: "warning\n", stream: "stderr" },
            ];
        },
    }, "ctx-own", "call-shell");
    assert.equal(output?.stdout, "ready\ntoken=[redacted]\n");
    assert.equal(output?.stderr, "warning\n");
    assert.equal(JSON.stringify(output).includes("foreign log"), false);
    assert.equal(JSON.stringify(output).includes("example-credential"), false);
    assert.deepEqual(queries[0], {
        ctxId: "ctx-own", callIds: ["call-shell"], limit: 1,
        includeInput: false, includeOutput: true, maxBytes: 64 * 1024,
    });
    assert.deepEqual(queries[1], {
        callId: "call-shell", ctxId: "ctx-own", fromSeq: 1,
        limit: 32, maxDecodedBytes: 256 * 1024,
    });
});

test("Activity refuses calls from other Contexts before reading any logs", async () => {
    let logsRead = 0;
    const output = await readMcpAppActivityOutput({
        listCalls: async () => [call("foreign", "ctx-other", "bash_run", 1)],
    }, {
        readLogs: async () => { logsRead++; return []; },
    }, "ctx-own", "foreign");
    assert.equal(output, undefined);
    assert.equal(logsRead, 0);
});

test("Activity paginates long stdout without loading more than a bounded page", async () => {
    const output = await readMcpAppActivityOutput({
        listCalls: async () => [call("paged", "ctx-own", "bash_run", 1)],
    }, {
        readLogs: async () => Array.from({ length: 32 }, (_, index) => ({
            at: "", seq: index + 1, instanceName: "demo", callId: "paged", ctxId: "ctx-own",
            message: "line\n", stream: "stdout" as const,
        })),
    }, "ctx-own", "paged");
    assert.equal(output?.stdout, "line\n".repeat(32));
    assert.equal(output?.nextSeq, 33);
});
