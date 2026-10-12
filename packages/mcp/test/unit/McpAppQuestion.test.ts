import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpAppQuestionStore } from "../../src/mcpapp/Question.ts";

test("question inbox projects only the owning Context, resolves a waiting ask and survives restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "devshell-mcpapp-question-"));
    const file = join(dir, "questions.json");
    try {
        const questions = new McpAppQuestionStore(file);
        await questions.initialize();
        const before = questions.revision;
        const change = questions.changedSince(before);
        const created = await questions.create("alpha", "ctx-a", {
            question: "Select deployment strategy", choices: ["Canary", "Blue-green"], allowText: false,
        });
        assert.equal(await change, true);
        assert.equal(questions.pending("alpha", "ctx-b").length, 0);
        assert.equal(questions.pending("beta", "ctx-a").length, 0);
        assert.equal(questions.pending("alpha", "ctx-a")[0]?.question, "Select deployment strategy");
        assert.throws(() => questions.assertAnswer("alpha", "ctx-b", created.id, "Canary"));
        assert.throws(() => questions.assertAnswer("alpha", "ctx-a", created.id, "Arbitrary"));
        const waiting = questions.wait(created.id);
        const answered = await questions.answer("alpha", "ctx-a", created.id, "Canary");
        assert.equal(answered.detached, false);
        assert.equal(await waiting, "Canary");
        assert.equal(questions.pending("alpha", "ctx-a").length, 0);
        const persisted = await readFile(file, "utf8");
        assert.ok(!persisted.includes("token"));
        const restored = new McpAppQuestionStore(file);
        await restored.initialize();
        assert.equal(await restored.wait(created.id), "Canary");
        assert.deepEqual(restored.pending("alpha", "ctx-a"), []);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test("cancelled MCP call leaves a durable pending question and a later answer is detached", async () => {
    const questions = new McpAppQuestionStore();
    const created = await questions.create("demo", "ctx", { question: "How should this proceed?" });
    const cancelled = new AbortController();
    const wait = questions.wait(created.id, cancelled.signal);
    cancelled.abort();
    await assert.rejects(wait, /cancelled/);
    assert.equal(questions.pending("demo", "ctx").length, 1);
    const result = await questions.answer("demo", "ctx", created.id, "Proceed in stages");
    assert.equal(result.detached, true);
    assert.equal(await questions.wait(created.id), "Proceed in stages");
    await questions.revokeContext("ctx");
    assert.equal(questions.pending("demo", "ctx").length, 0);
});
