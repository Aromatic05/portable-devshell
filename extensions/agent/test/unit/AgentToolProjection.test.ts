import assert from "node:assert/strict";
import test from "node:test";

import {
    prepareAgentModelToolInput,
    projectAgentModelToolResult,
    projectAgentModelTools
} from "../../src/builtin/provider/AgentToolProjection.ts";

test("Agent model projection filters capabilities and strips non-model input fields", () => {
    const bashSchema = {
        additionalProperties: false,
        properties: {
            command: { type: "string" },
            ctxId: { type: "string" },
            explanation: { type: "string" },
            instance: { type: "string" },
            purpose: { type: "string" }
        },
        required: ["command", "purpose", "instance"],
        type: "object"
    };
    const projected = projectAgentModelTools([
        { description: "Run bash", inputSchema: bashSchema, name: "bash_run" },
        {
            description: "Edit files",
            inputSchema: {
                properties: {
                    changes: { type: "string" },
                    resultDetail: { type: "string" }
                },
                required: ["changes", "resultDetail"],
                type: "object"
            },
            name: "file_edit"
        },
        {
            description: "Read tmux output",
            inputSchema: {
                properties: {
                    consumeOutput: { type: "boolean" },
                    task: { type: "string" }
                },
                type: "object"
            },
            name: "tmux_read"
        },
        { description: "Host-internal capability", inputSchema: { type: "object" }, name: "future_internal" }
    ]);

    assert.deepEqual(projected.map((tool) => tool.name), ["bash_run", "file_edit", "tmux_read"]);
    assert.deepEqual(
        (projected[0]?.inputSchema as { properties?: Record<string, unknown> }).properties,
        { command: { type: "string" } }
    );
    assert.deepEqual((projected[0]?.inputSchema as { required?: string[] }).required, ["command"]);
    assert.equal(
        (projected[1]?.inputSchema as { properties?: Record<string, unknown> }).properties?.resultDetail,
        undefined
    );
    assert.equal(
        (projected[2]?.inputSchema as { properties?: Record<string, unknown> }).properties?.consumeOutput,
        undefined
    );
    assert.notEqual(bashSchema.properties.purpose, undefined, "projection must not mutate the canonical Worker schema");
});

test("Agent model projection owns input preparation and bounded result projection", () => {
    const changes = "*** Begin Edit\n*** Write File: ./demo.txt\nhello\n*** End Edit";
    assert.deepEqual(
        prepareAgentModelToolInput("file_edit", { changes, resultDetail: "summary" }),
        { changes, resultDetail: "diff" }
    );

    const recoveryPath = "/.devshell/tool-results/11111111-1111-1111-1111-111111111111/stdout";
    const text = projectAgentModelToolResult("bash_run", {
        exitCode: 0,
        stderr: "",
        stdout: `head-${"x".repeat(100_000)}-tail`,
        stdoutArtifact: { handle: "private-handle" },
        stdoutPath: recoveryPath,
        termination: "exited"
    });
    assert.equal(text.length, 12_000);
    assert.match(text, /tool result truncated/u);
    assert.match(text, /head-/u);
    assert.match(text, /-tail/u);
    assert.equal(text.includes(recoveryPath), true);
    assert.doesNotMatch(text, /stdoutArtifact|private-handle/u);
});
