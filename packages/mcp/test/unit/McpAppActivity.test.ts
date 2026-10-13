import assert from "node:assert/strict";
import test from "node:test";
import { asInstanceName, type ToolCallRecord } from "@portable-devshell/shared";
import { projectMcpAppActivity, readMcpAppActivity } from "../../src/mcpapp/Activity.ts";

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
    const requested: Array<Record<string, unknown>> = [];
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
