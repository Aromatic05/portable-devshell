import assert from "node:assert/strict";
import test from "node:test";

import type { JsonValue } from "@portable-devshell/shared";

import {
    createDevshellPiExtension,
    expandDevshellPiPromptTemplate,
    loadDevshellPiWorkspaceContext,
    type PiToolLike,
} from "../../src/provider/pi/adapt/index.ts";

test("Pi devshell tool forwards Worker progress through Pi onUpdate before the final result", async () => {
    let registeredTool:
        | {
              execute(
                  toolCallId: string,
                  params: unknown,
                  signal?: AbortSignal,
                  onUpdate?: (result: {
                      content: Array<{ text: string; type: "text" }>;
                      details: JsonValue;
                  }) => void,
              ): Promise<{
                  content: Array<{ text: string; type: "text" }>;
                  details: JsonValue;
              }>;
          }
        | undefined;
    const extension = createDevshellPiExtension(
        {
            target: { instance: "worker-a", workspace: "/repo" },
            modelTools: [
                {
                    description: "Run bash",
                    inputSchema: { type: "object" },
                    name: "bash_run",
                },
            ],
            tools: [
                {
                    description: "Run bash",
                    inputSchema: { type: "object" },
                    name: "bash_run",
                },
            ],
            async callTool(
                _toolName,
                _input,
                operationId,
                _signal,
                onProgress,
            ) {
                assert.equal(operationId, "call-stream");
                onProgress?.({
                    durationMs: 125,
                    stderr: "",
                    stdout: "partial\n",
                    termination: "running",
                });
                return {
                    durationMs: 250,
                    exitCode: 0,
                    stderr: "",
                    stdout: "partial\nfinal\n",
                    termination: "exited",
                };
            },
            close() {},
        },
        { closeSessionOnShutdown: false },
    );
    await extension({
        getCommands: () => [],
        on() {},
        registerCommand() {},
        registerTool(tool) {
            registeredTool = tool;
        },
        sendUserMessage() {},
    });
    assert.notEqual(registeredTool, undefined);
    const updates: Array<{
        content: Array<{ text: string; type: "text" }>;
        details: JsonValue;
    }> = [];

    const result = await registeredTool!.execute(
        "call-stream",
        { command: "printf partial; printf final" },
        undefined,
        (update) => updates.push(update),
    );

    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0]?.details, {
        durationMs: 125,
        stderr: "",
        stdout: "partial\n",
        termination: "running",
    });
    assert.match(updates[0]?.content[0]?.text ?? "", /partial/u);
    assert.deepEqual(result.details, {
        durationMs: 250,
        exitCode: 0,
        stderr: "",
        stdout: "partial\nfinal\n",
        termination: "exited",
    });
});

test("Pi devshell structured tool failures remain errors with model-visible metadata", async () => {
    let registeredTool: PiToolLike | undefined;
    let toolResultHandler:
        | ((event: {
              content: Array<{ text: string; type: "text" }>;
              details: unknown;
              input: Record<string, unknown>;
              isError: boolean;
              toolCallId: string;
              toolName: string;
          }) =>
              | Promise<
                    | {
                          content?: Array<{ text: string; type: "text" }>;
                          details?: unknown;
                          isError?: boolean;
                      }
                    | void
                >
              | {
                    content?: Array<{ text: string; type: "text" }>;
                    details?: unknown;
                    isError?: boolean;
                }
              | void)
        | undefined;
    const extension = createDevshellPiExtension(
        {
            target: { instance: "worker-a", workspace: "/repo" },
            modelTools: [
                {
                    description: "Edit files",
                    inputSchema: { type: "object" },
                    name: "file_edit",
                },
            ],
            tools: [
                {
                    description: "Edit files",
                    inputSchema: { type: "object" },
                    name: "file_edit",
                },
            ],
            async callTool() {
                throw Object.assign(new Error("snapshot required"), {
                    code: "file.snapshotRequired",
                    details: { path: "./document.txt" },
                    retryable: true,
                });
            },
            close() {},
        },
        { closeSessionOnShutdown: false },
    );
    await extension({
        getCommands: () => [],
        on(event: string, handler: unknown) {
            if (event === "tool_result") {
                toolResultHandler = handler as typeof toolResultHandler;
            }
        },
        registerCommand() {},
        registerTool(tool) {
            registeredTool = tool;
        },
        sendUserMessage() {},
    });
    assert.notEqual(registeredTool, undefined);
    assert.notEqual(toolResultHandler, undefined);

    const result = await registeredTool!.execute("call-error", {
        changes: "...",
    });
    const projected = JSON.parse(result.content[0]!.text) as {
        error?: unknown;
    };
    assert.deepEqual(projected.error, {
        code: "file.snapshotRequired",
        details: { path: "./document.txt" },
        message: "snapshot required",
        retryable: true,
    });

    const hookResult = await toolResultHandler!({
        content: result.content,
        details: result.details,
        input: { changes: "..." },
        isError: false,
        toolCallId: "call-error",
        toolName: "file_edit",
    });
    assert.equal(hookResult?.isError, true);
    assert.deepEqual(hookResult?.details, {
        error: {
            code: "file.snapshotRequired",
            details: { path: "./document.txt" },
            message: "snapshot required",
            retryable: true,
        },
    });
});

test("Pi devshell leaves non-namespaced runtime errors on the native throw path", async () => {
    let registeredTool: PiToolLike | undefined;
    const extension = createDevshellPiExtension(
        {
            target: { instance: "worker-a", workspace: "/repo" },
            modelTools: [
                {
                    description: "Run bash",
                    inputSchema: { type: "object" },
                    name: "bash_run",
                },
            ],
            tools: [
                {
                    description: "Run bash",
                    inputSchema: { type: "object" },
                    name: "bash_run",
                },
            ],
            async callTool() {
                throw Object.assign(new Error("pipe closed"), { code: "EPIPE" });
            },
            close() {},
        },
        { closeSessionOnShutdown: false },
    );
    await extension({
        getCommands: () => [],
        on() {},
        registerCommand() {},
        registerTool(tool) {
            registeredTool = tool;
        },
        sendUserMessage() {},
    });
    assert.notEqual(registeredTool, undefined);

    await assert.rejects(
        () => registeredTool!.execute("call-runtime-error", { command: "true" }),
        (error: unknown) =>
            error instanceof Error &&
            error.message === "pipe closed" &&
            (error as Error & { code?: string }).code === "EPIPE",
    );
});

test("Pi devshell workspace context respects tool capability restrictions", async () => {
    let calls = 0;
    const contextFiles = await loadDevshellPiWorkspaceContext(
        { instance: "worker-a", workspace: "/repo" },
        new Set(["file_read"]),
        async () => {
            calls += 1;
            return {};
        },
    );
    assert.deepEqual(contextFiles, []);
    assert.equal(calls, 0);
});

test("Pi devshell remote prompt expansion matches Pi positional and aggregate argument semantics", () => {
    const prompt = {
        content:
            "one=$1 all=$ARGUMENTS fallback=${3:-stable} tail=${@:2} pair=${@:2:2}",
        description: "release",
        filePath: "/repo/.pi/prompts/release.md",
        name: "release",
        sourceInfo: {
            baseDir: "/repo/.pi/prompts",
            origin: "top-level" as const,
            path: "/repo/.pi/prompts/release.md",
            scope: "project" as const,
            source: "local",
        },
    };
    assert.equal(
        expandDevshellPiPromptTemplate(prompt, "v1 'release candidate'"),
        "one=v1 all=v1 release candidate fallback=stable tail=release candidate pair=release candidate",
    );
});