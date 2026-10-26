import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionJsonValue } from "@portable-devshell/extension";
import type { AccessRuntime } from "../../src/builtin/AccessRuntime.js";
import { executeAccessCommand } from "../../src/builtin/AccessCommand.js";

function fixture(chunks: string[], state = "running") {
    const saved: ExtensionJsonValue[] = [];
    let stderr = "";
    const runtime = {
        async upsert(value: ExtensionJsonValue) {
            saved.push(value);
            return { id: "ssh-mcp", state, origin: "http://127.0.0.1:17890/",
                ...(state === "error" ? { error: "SSH authentication refused" } : {}) };
        },
    } as unknown as AccessRuntime;
    const context = {
        localOwner: true, requestId: "fixture", signal: new AbortController().signal,
        io: {
            async readInput() { const next = chunks.shift(); return next === undefined ? undefined : Buffer.from(next); },
            async requestInput() {},
            async writeStderr(text: string) { stderr += text; },
            async writeStdout() {},
        },
    };
    return { runtime, context, saved, stderr: () => stderr };
}

test("SSH wizard preserves pasted lines and CRLF split across chunks", async () => {
    const f = fixture(["gateway\r", "\nalice\r\n22\r\n127.0.0.1\r", "\n17890\nhttps://public.example\n"]);
    await executeAccessCommand(f.runtime, ["ssh"], f.context);
    assert.deepEqual(f.saved, [{ enabled: true, host: "gateway", id: "ssh-mcp", port: 22,
        provider: "ssh", user: "alice", remoteBindHost: "127.0.0.1", remotePort: 17890,
        publicUrl: "https://public.example", target: "mcp" }]);
});

test("SSH wizard rejects whole invalid ports and retries the same field", async () => {
    const f = fixture(["gateway\n\n22oops\n17890.5\n0\n65536\n22\n\n1e3\n17890\n\n"]);
    await executeAccessCommand(f.runtime, ["ssh"], f.context);
    assert.equal((f.saved[0] as Record<string, unknown>).port, 22);
    assert.equal((f.saved[0] as Record<string, unknown>).remotePort, 17890);
    assert.equal(f.stderr().match(/Please try again/gu)?.length, 5);
});

test("SSH wizard fails on invalid port at EOF without saving or looping", async () => {
    const f = fixture(["gateway\n\n22oops"]);
    await assert.rejects(executeAccessCommand(f.runtime, ["ssh"], f.context), /Port must be an integer/u);
    assert.deepEqual(f.saved, []);
});

test("SSH startup error reports saved configuration, failure and recovery", async () => {
    const f = fixture(["gateway\n\n\n\n17890\n\n"], "error");
    await assert.rejects(executeAccessCommand(f.runtime, ["ssh"], f.context), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /configuration saved, but the tunnel failed to connect/u);
        assert.match(error.message, /SSH authentication refused/u);
        assert.match(error.message, /State: error/u);
        assert.match(error.message, /devshell access show ssh-mcp/u);
        assert.match(error.message, /devshell access reload/u);
        return true;
    });
    assert.equal(f.saved.length, 1);
});

for (const state of ["running", "waiting"]) {
    test(`SSH setup reports current ${state} state separately from configuration`, async () => {
        const f = fixture(["gateway\n\n\n\n17890\n\n"], state);
        const result = await executeAccessCommand(f.runtime, ["ssh"], f.context);
        assert.equal(result.kind, "text");
        if (result.kind === "text") {
            assert.match(result.text, new RegExp(`Tunnel state: ${state}`, "u"));
            if (state === "waiting") assert.match(result.text, /not connected yet/u);
        }
    });
}
