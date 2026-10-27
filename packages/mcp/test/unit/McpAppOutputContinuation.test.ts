import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { asInstanceName, type ToolCallRecord } from "@portable-devshell/shared";
import { AuditDatabase } from "../../../core/src/audit/database/index.ts";
import type { InstanceLogEntry } from "../../../core/src/audit/Api.ts";
import { LogStoreInstance } from "../../../core/src/audit/log/index.ts";
import { readMcpAppActivityOutput } from "../../src/mcpapp/Activity.ts";

test("历史单条 300031 字节中文日志可以两页无损读取，第三页结束且 stderr 保留", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-output-e03-"));
    const database = new AuditDatabase(join(root, "audit.sqlite3"), { maxBytes: 32 * 1024 * 1024, retentionDays: 7 });
    try {
        const store = new LogStoreInstance(asInstanceName("demo"), database.store<InstanceLogEntry>("logs", {
            sequence: (entry) => entry.seq, timestamp: (entry) => entry.at,
        }), (query) => database.readCallLogRecords(query));
        const stdout = "BEGIN\n" + "中".repeat(50_000) + "\nMIDDLE-MUST-SURVIVE\n" + "文".repeat(50_000) + "\nEND";
        assert.equal(Buffer.byteLength(stdout), 300031);
        const context = { callId: "long", ctxId: "ctx-own" };
        // 历史记录直接入库，不能依赖修复后的 producer 重写已有日志。
        await store.append("stdout", stdout, new Date().toISOString(), context);
        await store.append("stdout", "foreign", new Date().toISOString(), { ...context, ctxId: "ctx-other" });
        await store.append("stderr", "错误😀\n", new Date().toISOString(), context);
        const tools = { listCalls: async () => [{ ...context, toolName: "bash_run" } as ToolCallRecord] };
        const process = { readLogs: (query: Parameters<typeof store.read>[0]) => store.read(query) };
        const read = (seq = 1, offset = 0) => readMcpAppActivityOutput(tools, process, "ctx-own", "long", seq, offset);
        const first = (await read())!;
        assert.ok(Buffer.byteLength(first.stdout + first.stderr) <= 256 * 1024);
        assert.equal(first.nextSeq, 1);
        assert.ok(first.nextOffset! > 0);
        const second = (await read(first.nextSeq, first.nextOffset))!;
        assert.equal(first.stdout + second.stdout, stdout);
        assert.equal(first.stderr + second.stderr, "错误😀\n");
        assert.ok(Buffer.byteLength(second.stdout + second.stderr) <= 256 * 1024);
        assert.equal((first.stdout + second.stdout).includes("�"), false);
        assert.equal(second.nextOffset, undefined);
        const third = (await read(second.nextSeq ?? 4))!;
        assert.deepEqual(third, { callId: "long", stdout: "", stderr: "" });
        await assert.rejects(read(1, 7), /offset/u);
    } finally {
        database.close(); await rm(root, { recursive: true, force: true });
    }
});

test("分页尾部不足一个 emoji 时保留下一条 seq，不能返回零偏移死循环", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-output-boundary-"));
    const database = new AuditDatabase(join(root, "audit.sqlite3"), { maxBytes: 32 * 1024 * 1024, retentionDays: 7 });
    try {
        const store = new LogStoreInstance(asInstanceName("demo"), database.store<InstanceLogEntry>("logs", {
            sequence: (entry) => entry.seq, timestamp: (entry) => entry.at,
        }), (query) => database.readCallLogRecords(query));
        const context = { callId: "boundary", ctxId: "ctx-own" };
        await store.append("stdout", "x".repeat(256 * 1024 - 1), new Date().toISOString(), context);
        await store.append("stderr", "😀错误", new Date().toISOString(), context);
        const tools = { listCalls: async () => [{ ...context, toolName: "bash_run" } as ToolCallRecord] };
        const process = { readLogs: (query: Parameters<typeof store.read>[0]) => store.read(query) };
        const first = (await readMcpAppActivityOutput(tools, process, "ctx-own", "boundary"))!;
        assert.equal(first.nextSeq, 2); assert.equal(first.nextOffset, undefined);
        assert.equal(first.stderr, "");
        const second = (await readMcpAppActivityOutput(tools, process, "ctx-own", "boundary", first.nextSeq))!;
        assert.equal(second.stderr, "😀错误"); assert.equal(second.nextSeq, undefined);
    } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});
