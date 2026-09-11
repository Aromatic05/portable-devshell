import assert from "node:assert/strict";
import test from "node:test";

import type { Component } from "@earendil-works/pi-tui";
import type { JsonValue } from "@portable-devshell/shared";

import { prepareAgentModelToolInput } from "../../src/builtin/provider/AgentToolProjection.ts";
import {
    appendDevshellRemoteWorkspacePrompt,
    createDevshellPiExtension,
    createDevshellPiWorkspaceBridge,
    createStandaloneDevshellPiExtension,
    expandDevshellPiPromptTemplate,
    loadDevshellPiWorkspaceContext,
    loadDevshellPiWorkspaceResources,
    piPromptMetadata,
    replacePiProjectContext,
    transformDevshellPiSkillInput
} from "../../src/provider/pi/extension/index.ts";
import standaloneDevshellPiExtension from "../../src/provider/pi/extension/index.ts";
import {
    devshellPiRendererToolNames,
    formatPiToolCall,
    formatPiToolResult,
    hasExplicitPiToolRenderer,
    parseEditChangeSet,
    renderPiToolCall,
    renderPiToolResult,
    renderWorkerUnifiedDiff,
    type PiThemeLike,
    type PiToolRenderContextLike
} from "../../src/provider/pi/extension/renderer.ts";

test("Pi devshell adapter requires an injected tool session instead of opening Control itself", async () => {
    let closes = 0;
    const session = {
        target: { instance: "worker-a", workspace: "/repo" },
        modelTools: [],
        tools: [],
        async callTool() {
            throw new Error("tool call not expected");
        },
        close() {
            closes += 1;
        }
    };
    assert.equal(typeof createDevshellPiExtension(session), "function");
    const bridge = createDevshellPiWorkspaceBridge(session);
    assert.deepEqual(await bridge.loadResources(), { contextFiles: [], prompts: [], skills: [] });
    await bridge.close();
    await bridge.close();
    assert.equal(closes, 1);
});

test("Pi registers only Agent model tools while retaining canonical tools for internal resources", async () => {
    const calls: string[] = [];
    const registered: string[] = [];
    const bridge = createDevshellPiWorkspaceBridge({
        target: { instance: "worker-a", workspace: "/repo" },
        modelTools: [{ description: "Read files", inputSchema: { type: "object" }, name: "file_read" }],
        tools: [
            { description: "Find files", inputSchema: { type: "object" }, name: "file_glob" },
            { description: "Read files", inputSchema: { type: "object" }, name: "file_read" },
            { description: "Internal only", inputSchema: { type: "object" }, name: "future_internal" }
        ],
        async callTool(toolName, _input, _operationId) {
            calls.push(toolName);
            if (toolName === "file_glob") return { entries: [] };
            if (toolName === "file_read") return {
                files: [
                    { path: "./.pi/skills", view: "metadata", metadata: { exists: false } },
                    { path: "./.pi/prompts", view: "metadata", metadata: { exists: false } }
                ]
            };
            throw new Error(`unexpected tool call: ${toolName}`);
        },
        close() {}
    });

    await bridge.extension({
        getCommands: () => [],
        on() {},
        registerCommand() {},
        registerTool(tool) { registered.push(tool.name); },
        sendUserMessage() {}
    });

    assert.deepEqual(registered, ["file_read"]);
    assert.equal(calls.includes("file_glob"), true);
    assert.equal(calls.includes("file_read"), true);
    await bridge.close();
});

test("standalone default export is a Pi extension factory, not the factory generator", () => {
    assert.equal(typeof standaloneDevshellPiExtension, "function");
    assert.notEqual(standaloneDevshellPiExtension, createStandaloneDevshellPiExtension);
});

test("managed Pi adapter leaves tool-session shutdown to its embedding owner", async () => {
    let closes = 0;
    const registeredEvents: string[] = [];
    const extension = createDevshellPiExtension({
        target: { instance: "worker-a", workspace: "/repo" },
        modelTools: [],
        tools: [],
        async callTool() {
            throw new Error("tool call not expected");
        },
        close() {
            closes += 1;
        }
    }, { closeSessionOnShutdown: false });
    await extension({
        getCommands: () => [],
        on(event) {
            registeredEvents.push(event);
        },
        registerCommand() {},
        registerTool() {},
        sendUserMessage() {}
    });

    assert.equal(registeredEvents.includes("session_shutdown"), false);
    assert.equal(closes, 0);
});

test("Pi devshell tool forwards Worker progress through Pi onUpdate before the final result", async () => {
    let registeredTool: {
        execute(
            toolCallId: string,
            params: unknown,
            signal?: AbortSignal,
            onUpdate?: (result: { content: Array<{ text: string; type: "text" }>; details: JsonValue }) => void
        ): Promise<{ content: Array<{ text: string; type: "text" }>; details: JsonValue }>;
    } | undefined;
    const extension = createDevshellPiExtension({
        target: { instance: "worker-a", workspace: "/repo" },
        modelTools: [{ description: "Run bash", inputSchema: { type: "object" }, name: "bash_run" }],
        tools: [{ description: "Run bash", inputSchema: { type: "object" }, name: "bash_run" }],
        async callTool(_toolName, _input, operationId, _signal, onProgress) {
            assert.equal(operationId, "call-stream");
            onProgress?.({ durationMs: 125, stderr: "", stdout: "partial\n", termination: "running" });
            return { durationMs: 250, exitCode: 0, stderr: "", stdout: "partial\nfinal\n", termination: "exited" };
        },
        close() {}
    }, { closeSessionOnShutdown: false });
    await extension({
        getCommands: () => [],
        on() {},
        registerCommand() {},
        registerTool(tool) { registeredTool = tool; },
        sendUserMessage() {}
    });
    assert.notEqual(registeredTool, undefined);
    const updates: Array<{ content: Array<{ text: string; type: "text" }>; details: JsonValue }> = [];

    const result = await registeredTool!.execute(
        "call-stream",
        { command: "printf partial; printf final" },
        undefined,
        (update) => updates.push(update)
    );

    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0]?.details, {
        durationMs: 125,
        stderr: "",
        stdout: "partial\n",
        termination: "running"
    });
    assert.match(updates[0]?.content[0]?.text ?? "", /partial/u);
    assert.deepEqual(result.details, {
        durationMs: 250,
        exitCode: 0,
        stderr: "",
        stdout: "partial\nfinal\n",
        termination: "exited"
    });
});

test("Pi devshell tool hard-limits model content for long single-line progress and final results", async () => {
    let registeredTool: {
        execute(
            toolCallId: string,
            params: unknown,
            signal?: AbortSignal,
            onUpdate?: (result: { content: Array<{ text: string; type: "text" }>; details: JsonValue }) => void
        ): Promise<{ content: Array<{ text: string; type: "text" }>; details: JsonValue }>;
    } | undefined;
    const longLine = `head-${"x".repeat(100_000)}-tail`;
    const recoveryPath = "/.devshell/tool-results/11111111-1111-1111-1111-111111111111/stdout";
    const extension = createDevshellPiExtension({
        target: { instance: "worker-a", workspace: "/repo" },
        modelTools: [{ description: "Run bash", inputSchema: { type: "object" }, name: "bash_run" }],
        tools: [{ description: "Run bash", inputSchema: { type: "object" }, name: "bash_run" }],
        async callTool(_toolName, _input, _operationId, _signal, onProgress) {
            onProgress?.({ stderr: "", stdout: longLine, termination: "running" });
            return {
                exitCode: 0,
                stderr: "",
                stdout: longLine,
                stdoutArtifact: { artifactTruncated: false, handle: "private-handle", stream: "stdout" },
                stdoutPath: recoveryPath,
                termination: "exited"
            };
        },
        close() {}
    }, { closeSessionOnShutdown: false });
    await extension({
        getCommands: () => [],
        on() {},
        registerCommand() {},
        registerTool(tool) { registeredTool = tool; },
        sendUserMessage() {}
    });
    assert.notEqual(registeredTool, undefined);
    const updates: Array<{ content: Array<{ text: string; type: "text" }>; details: JsonValue }> = [];

    const result = await registeredTool!.execute("call-long-output", { command: "produce-output" }, undefined, (update) => updates.push(update));
    const progressText = updates[0]?.content[0]?.text ?? "";
    const finalText = result.content[0]?.text ?? "";

    assert.equal(updates.length, 1);
    assert.equal(progressText.length < 12_000, true);
    assert.equal(finalText.length < 12_000, true);
    assert.match(progressText, /semantic preview clipped: \d+ characters total/u);
    assert.match(finalText, /semantic preview clipped: \d+ characters total/u);
    assert.match(progressText, /head-/u);
    assert.match(progressText, /-tail/u);
    assert.match(finalText, /head-/u);
    assert.match(finalText, /-tail/u);
    assert.match(finalText, new RegExp(recoveryPath.replaceAll("/", "\\/"), "u"));
    assert.doesNotMatch(finalText, /stdoutArtifact|private-handle/u);
    assert.deepEqual((result.details as { stdout?: string }).stdout, longLine);
    assert.equal((result.details as { stdoutArtifact?: { handle?: string } }).stdoutArtifact?.handle, "private-handle");
});

const identityTheme: PiThemeLike = {
    bg: (_role, text) => text,
    bold: (text) => text,
    fg: (_role, text) => text,
    inverse: (text) => `[${text}]`
};

function context(args: unknown): PiToolRenderContextLike {
    return {
        args,
        argsComplete: true,
        cwd: "/repo",
        executionStarted: false,
        expanded: false,
        invalidate() {},
        isError: false,
        isPartial: false,
        showImages: false,
        state: {},
        toolCallId: "call-1"
    };
}

function visibleLines(component: Component): string[] {
    return component.render(120)
        .map((line) => line.slice(1).trimEnd())
        .filter((line, index, lines) => line.length > 0 || (index > 0 && index < lines.length - 1));
}

function visibleSelfLines(component: Component): string[] {
    return component.render(120)
        .map((line) => line.trimEnd())
        .filter((line, index, lines) => line.length > 0 || (index > 0 && index < lines.length - 1));
}

test("Pi devshell workspace context follows native Pi file priority and reconstructs paged text", async () => {
    const calls: Array<{ input: unknown; operationId: string; toolName: string }> = [];
    const contextFiles = await loadDevshellPiWorkspaceContext(
        { instance: "worker-a", workspace: "/repo" },
        new Set(["file_glob", "file_read"]),
        async (toolName, input, operationId): Promise<JsonValue> => {
            calls.push({ input, operationId, toolName });
            if (toolName === "file_glob") {
                return {
                    entries: [
                        { path: "./CLAUDE.md", type: "file" },
                        { path: "./AGENTS.md", type: "file" },
                        { path: "./AGENTS.override.md", type: "file" }
                    ]
                };
            }
            if (operationId === "pi-context-read-1") {
                return {
                    files: [{
                        content: "1:# Override rules\n2:alpha",
                        nextSelector: "3",
                        path: "./AGENTS.override.md",
                        view: "content"
                    }]
                };
            }
            assert.equal(operationId, "pi-context-read-2");
            return {
                files: [{
                    content: "3:\n4:omega",
                    path: "./AGENTS.override.md",
                    view: "content"
                }]
            };
        }
    );

    assert.deepEqual(contextFiles, [{
        content: "# Override rules\nalpha\n\nomega",
        path: "worker-a:/repo/AGENTS.override.md"
    }]);
    assert.equal(calls[0]?.toolName, "file_glob");
    assert.deepEqual(calls[0]?.input, {
        gitignore: false,
        hidden: true,
        patterns: ["./AGENTS*", "./CLAUDE*"],
        type: "file"
    });
    assert.deepEqual(calls[1]?.input, {
        files: [{ path: "./AGENTS.override.md", view: "content" }]
    });
    assert.deepEqual(calls[2]?.input, {
        files: [{ path: "./AGENTS.override.md", selector: "3:raw", view: "content" }]
    });
});

test("Pi devshell workspace context respects tool capability restrictions", async () => {
    let calls = 0;
    const contextFiles = await loadDevshellPiWorkspaceContext(
        { instance: "worker-a", workspace: "/repo" },
        new Set(["file_read"]),
        async () => {
            calls += 1;
            return {};
        }
    );
    assert.deepEqual(contextFiles, []);
    assert.equal(calls, 0);
});

test("Pi devshell workspace resources load native project skills and prompt templates from the remote target", async () => {
    const files = new Map<string, string>([
        ["./AGENTS.md", "# Project rules"],
        ["./.pi/skills/review/SKILL.md", [
            "---",
            "name: review",
            "description: Review the current change",
            "---",
            "Check tests before implementation."
        ].join("\n")],
        ["./.pi/prompts/release.md", [
            "---",
            "description: Prepare a release",
            "argument-hint: '[version]'",
            "---",
            "Release $1 only after the gate is green."
        ].join("\n")]
    ]);
    const resources = await loadDevshellPiWorkspaceResources(
        { instance: "worker-a", workspace: "/repo" },
        new Set(["file_glob", "file_read"]),
        async (toolName, input): Promise<JsonValue> => {
            if (toolName === "file_glob") {
                return {
                    entries: [...files.keys()].map((path) => ({ path, type: "file" }))
                };
            }
            const requests = (input as { files: Array<{ path: string; view: string }> }).files;
            if (requests.every((request) => request.view === "metadata")) {
                return {
                    files: requests.map((request) => ({
                        metadata: { exists: true, type: "directory" },
                        path: request.path,
                        view: "metadata"
                    }))
                };
            }
            const path = requests[0]!.path;
            const content = files.get(path);
            assert.notEqual(content, undefined, path);
            return {
                files: [{
                    content: content!.split("\n").map((line, index) => `${index + 1}:${line}`).join("\n"),
                    path,
                    view: "content"
                }]
            };
        }
    );

    assert.deepEqual(resources.contextFiles, [{
        content: "# Project rules",
        path: "worker-a:/repo/AGENTS.md"
    }]);
    assert.equal(resources.skills.length, 1);
    assert.deepEqual(resources.skills[0]?.resource, {
        baseDir: "/repo/.pi/skills/review",
        description: "Review the current change",
        disableModelInvocation: false,
        filePath: "/repo/.pi/skills/review/SKILL.md",
        name: "review",
        sourceInfo: {
            baseDir: "/repo/.pi/skills/review",
            origin: "top-level",
            path: "/repo/.pi/skills/review/SKILL.md",
            scope: "project",
            source: "local"
        }
    });
    assert.equal(resources.skills[0]?.content.includes("Check tests before implementation."), true);
    assert.deepEqual(resources.prompts, [{
        argumentHint: "[version]",
        content: "Release $1 only after the gate is green.",
        description: "Prepare a release",
        filePath: "/repo/.pi/prompts/release.md",
        name: "release",
        sourceInfo: {
            baseDir: "/repo/.pi/prompts",
            origin: "top-level",
            path: "/repo/.pi/prompts/release.md",
            scope: "project",
            source: "local"
        }
    }]);
});

test("Pi devshell workspace resources probe optional remote directories before globbing", async () => {
    const cases: Array<{
        expectedPaths: string[];
        files: Map<string, string>;
        infoEntries: JsonValue[];
        promptNames: string[];
        skillNames: string[];
    }> = [
        {
            files: new Map([
                ["./.pi/prompts/release.md", "---\ndescription: Release\n---\nrelease"]
            ]),
            infoEntries: [
                { exists: false, path: "./.pi/skills" },
                { path: "./.pi/prompts", type: "directory" }
            ],
            expectedPaths: ["./.pi/prompts/*.md"],
            promptNames: ["release"],
            skillNames: []
        },
        {
            files: new Map([
                ["./.pi/skills/review/SKILL.md", "---\nname: review\ndescription: Review\n---\nreview"]
            ]),
            infoEntries: [
                { path: "./.pi/skills", type: "directory" },
                { exists: false, path: "./.pi/prompts" }
            ],
            expectedPaths: ["./.pi/skills/*.md", "./.pi/skills/**/SKILL.md"],
            promptNames: [],
            skillNames: ["review"]
        },
        {
            files: new Map<string, string>(),
            infoEntries: [
                { exists: false, path: "./.pi/skills" },
                { exists: false, path: "./.pi/prompts" }
            ],
            expectedPaths: [],
            promptNames: [],
            skillNames: []
        }
    ];

    for (const scenario of cases) {
        let resourceFindPaths: unknown;
        const resources = await loadDevshellPiWorkspaceResources(
            { instance: "worker-a", workspace: "/repo" },
            new Set(["file_glob", "file_read"]),
            async (toolName, input, operationId): Promise<JsonValue> => {
                if (operationId === "pi-context-glob") return { entries: [] };
                if (operationId === "pi-resources-metadata") {
                    return {
                        files: scenario.infoEntries.map((value) => {
                            const entry = value as { exists?: boolean; path: string; type?: string };
                            return {
                                metadata: {
                                    exists: entry.exists !== false,
                                    ...(entry.type === undefined ? {} : { type: entry.type })
                                },
                                path: entry.path,
                                view: "metadata"
                            };
                        })
                    };
                }
                if (operationId === "pi-resources-glob") {
                    resourceFindPaths = (input as { patterns: unknown }).patterns;
                    return {
                        entries: [...scenario.files.keys()].map((path) => ({ path, type: "file" }))
                    };
                }
                assert.equal(toolName, "file_read");
                const path = (input as { files: Array<{ path: string }> }).files[0]!.path;
                const content = scenario.files.get(path);
                assert.notEqual(content, undefined, path);
                return {
                    files: [{
                        content: content!.split("\n").map((line, index) => `${index + 1}:${line}`).join("\n"),
                        path,
                        view: "content"
                    }]
                };
            }
        );

        assert.deepEqual(resourceFindPaths, scenario.expectedPaths.length === 0 ? undefined : scenario.expectedPaths);
        assert.deepEqual(resources.prompts.map((prompt) => prompt.name), scenario.promptNames);
        assert.deepEqual(resources.skills.map((skill) => skill.resource.name), scenario.skillNames);
    }
});

test("Pi devshell remote skill input transform preserves Pi delivery while avoiding local file reads", () => {
    const transformed = transformDevshellPiSkillInput([
        {
            content: "---\ndescription: Review\n---\nReview carefully.",
            resource: {
                baseDir: "/repo/.pi/skills/review",
                description: "Review",
                disableModelInvocation: false,
                filePath: "/repo/.pi/skills/review/SKILL.md",
                name: "review",
                sourceInfo: {
                    baseDir: "/repo/.pi/skills/review",
                    origin: "top-level",
                    path: "/repo/.pi/skills/review/SKILL.md",
                    scope: "project",
                    source: "local"
                }
            }
        }
    ], {
        source: "interactive",
        streamingBehavior: "followUp",
        text: "/skill:review focus tests",
        type: "input"
    });

    assert.deepEqual(transformed, {
        action: "transform",
        text: [
            '<skill name="review" location="/repo/.pi/skills/review/SKILL.md">',
            "References are relative to /repo/.pi/skills/review.",
            "",
            "Review carefully.",
            "</skill>",
            "",
            "focus tests"
        ].join("\n")
    });
    assert.equal(transformDevshellPiSkillInput([], { source: "interactive", text: "/skill:review", type: "input" }), undefined);
});

test("Pi devshell remote prompt expansion matches Pi positional and aggregate argument semantics", () => {
    const prompt = {
        content: "one=$1 all=$ARGUMENTS fallback=${3:-stable} tail=${@:2} pair=${@:2:2}",
        description: "release",
        filePath: "/repo/.pi/prompts/release.md",
        name: "release",
        sourceInfo: {
            baseDir: "/repo/.pi/prompts",
            origin: "top-level" as const,
            path: "/repo/.pi/prompts/release.md",
            scope: "project" as const,
            source: "local"
        }
    };
    assert.equal(
        expandDevshellPiPromptTemplate(prompt, "v1 'release candidate'"),
        "one=v1 all=v1 release candidate fallback=stable tail=release candidate pair=release candidate"
    );
});

test("Pi devshell standalone context replaces local project instructions but preserves Pi user instructions", () => {
    const localContext = [
        { content: "global", path: "/home/test/.pi/agent/AGENTS.md" },
        { content: "local-project", path: "/repo/AGENTS.md" }
    ];
    const localBlock = [
        "",
        "",
        "<project_context>",
        "",
        "Project-specific instructions and guidelines:",
        "",
        '<project_instructions path="/home/test/.pi/agent/AGENTS.md">',
        "global",
        "</project_instructions>",
        "",
        '<project_instructions path="/repo/AGENTS.md">',
        "local-project",
        "</project_instructions>",
        "",
        "</project_context>",
        ""
    ].join("\n");
    const replaced = replacePiProjectContext(
        `base${localBlock}\nCurrent working directory: /repo`,
        localContext,
        [{ content: "remote-project", path: "worker-a:/srv/repo/AGENTS.md" }],
        "/home/test/.pi/agent"
    );
    assert.match(replaced, /global/u);
    assert.match(replaced, /worker-a:\/srv\/repo\/AGENTS\.md/u);
    assert.match(replaced, /remote-project/u);
    assert.doesNotMatch(replaced, /local-project/u);
    assert.match(
        appendDevshellRemoteWorkspacePrompt(replaced, { instance: "worker-a", workspace: "/srv/repo" }),
        /The real project workspace is worker-a:\/srv\/repo\./u
    );
});

test("Pi devshell edit tool contributes its Worker preconditions and grammar to the Pi system prompt", () => {
    const metadata = piPromptMetadata("file_edit");
    assert.match(metadata.promptSnippet ?? "", /Edit workspace files/u);
    assert.equal(metadata.promptGuidelines?.length, 2);
    assert.match(metadata.promptGuidelines?.[0] ?? "", /file_read or file_grep/u);
    assert.match(metadata.promptGuidelines?.[1] ?? "", /\*\*\* Patch File:/u);
    assert.match(metadata.promptGuidelines?.[1] ?? "", /Never use '\*\*\* Update File:'/u);
});

test("Pi devshell renderer formats common calls without JSON fallback", () => {
    assert.equal(
        formatPiToolCall("file_grep", { pattern: "renderCall", paths: ["./src", "./test"] }),
        "grep /renderCall/ in ./src, ./test"
    );
    assert.equal(
        formatPiToolCall("file_glob", { patterns: ["./src/**/*.ts"], type: "file" }),
        "glob ./src/**/*.ts file"
    );
    assert.equal(
        formatPiToolCall("bash_run", { command: "pnpm test", cwd: "./extensions/agent" }),
        "$ pnpm test in ./extensions/agent"
    );
});

test("Pi devshell renderer explicitly covers the current Agent model tool surface", () => {
    const expected = [
        "bash_run",
        "file_edit",
        "file_glob",
        "file_grep",
        "file_read",
        "tmux_close",
        "tmux_create",
        "tmux_input",
        "tmux_inspect",
        "tmux_list",
        "tmux_read",
        "tmux_run"
    ];
    assert.deepEqual([...devshellPiRendererToolNames], expected);
    for (const toolName of expected) assert.equal(hasExplicitPiToolRenderer(toolName), true, toolName);
    assert.equal(hasExplicitPiToolRenderer("future_tool"), false);
});

test("Pi devshell read renderer follows native collapsed and expanded semantics", () => {
    const args = { files: [{ path: "./src/demo.ts", selector: "10-12", view: "content" }] };
    const callContext = context(args);
    const call = renderPiToolCall("file_read", args, identityTheme, callContext);
    assert.deepEqual(visibleSelfLines(call), ["read ./src/demo.ts:10-12"]);

    const result = {
        content: [{ type: "text", text: "10:const value = 1;\n11:return value;" }],
        details: {
            files: [{
                path: "./src/demo.ts",
                content: "10:const value = 1;\n11:return value;",
                language: "typescript",
                truncated: true,
                nextSelector: "12"
            }]
        }
    };
    const collapsed = renderPiToolResult(
        "file_read",
        result,
        { expanded: false, isPartial: false },
        identityTheme,
        { ...callContext, lastComponent: undefined }
    );
    assert.deepEqual(collapsed.render(120), []);

    const expanded = renderPiToolResult(
        "file_read",
        result,
        { expanded: true, isPartial: false },
        identityTheme,
        { ...callContext, expanded: true, lastComponent: undefined }
    );
    assert.deepEqual(visibleSelfLines(expanded), [
        "10 const value = 1;",
        "11 return value;",
        "[More available: selector 12]"
    ]);
});

test("Pi devshell glob and metadata read results use native compact rows rather than structured keys", () => {
    assert.equal(
        formatPiToolResult("file_glob", {
            content: [],
            details: {
                entries: [
                    { path: "src", type: "directory" },
                    { path: "src/index.ts", type: "file" }
                ],
                nextCursor: "cursor-2"
            }
        }, false),
        ["src/", "src/index.ts", "[More results available: continue with next cursor]"].join("\n")
    );
    const info = formatPiToolResult("file_read", {
        content: [],
        details: {
            files: [
                { path: "./src", view: "metadata", metadata: { exists: true, type: "directory", mode: 493 } },
                { path: "./missing", view: "metadata", metadata: { exists: false } }
            ]
        }
    }, false);
    assert.match(info, /^\.\/src · directory · 0755$/mu);
    assert.match(info, /^\.\/missing · missing$/mu);
    assert.equal(info.includes("entries:"), false);
});

test("Pi devshell bash renderer shows a width-aware tail and completion status", () => {
    const callContext = context({ command: "pnpm test" });
    const result = renderPiToolResult("bash_run", {
        content: [],
        details: {
            exitCode: 0,
            stdout: "one\ntwo\nthree\nfour\nfive\nsix\nseven\n",
            stderr: "",
            stdoutTruncated: true,
            stderrTruncated: false,
            durationMs: 1234,
            termination: "exited"
        }
    }, { expanded: false, isPartial: false }, identityTheme, callContext);
    assert.deepEqual(result.render(120), [
        "",
        "... (2 earlier lines, Ctrl+O to expand)",
        "three",
        "four",
        "five",
        "six",
        "seven",
        "[stdout truncated]",
        "exit 0 · Took 1.2s"
    ]);

    const partial = renderPiToolResult("bash_run", {
        content: [],
        details: {
            stdout: "compiling\n",
            stderr: "",
            durationMs: 1250,
            termination: "running"
        }
    }, { expanded: false, isPartial: true }, identityTheme, { ...callContext, isPartial: true });
    assert.deepEqual(partial.render(120), ["", "compiling", "running · Elapsed 1.3s"]);
});

test("Pi devshell tmux renderer consumes Worker output arrays and keeps task state compact", () => {
    const rendered = formatPiToolResult("tmux_run", {
        content: [],
        details: {
            output: ["build", "test"],
            task: { id: "task-abc", status: "running" },
            detached: true
        }
    }, false);
    assert.equal(rendered, ["build", "test", "task-abc · running · detached"].join("\n"));
    assert.equal(rendered.includes("output:"), false);
    assert.equal(rendered.includes("task:"), false);
});

test("Pi devshell renderer turns file grep results into readable sections", () => {
    const rendered = formatPiToolResult("file_grep", {
        content: [],
        details: {
            files: [
                { path: "src/a.ts", content: "1:alpha\n2:beta" },
                { path: "src/b.ts", content: "7:gamma" }
            ]
        }
    }, false);
    assert.equal(rendered, [
        "src/a.ts",
        "  1:alpha",
        "  2:beta",
        "src/b.ts",
        "  7:gamma"
    ].join("\n"));
    assert.equal(rendered.includes("\"files\""), false);
});

test("Pi devshell file edit always requests diff details without exposing them to the model", () => {
    const changes = [
        "*** Begin Edit",
        "*** Patch File: ./a.txt",
        "@@",
        "-old",
        "+new",
        "*** End Edit"
    ].join("\n");
    assert.deepEqual(prepareAgentModelToolInput("file_edit", { changes }), { changes, resultDetail: "diff" });
    assert.deepEqual(prepareAgentModelToolInput("file_edit", { changes, resultDetail: "summary" }), { changes, resultDetail: "diff" });
});

test("Pi devshell parses the Worker edit grammar only as adapter input", () => {
    const operations = parseEditChangeSet([
        "*** Begin Edit",
        "*** Write File: ./new.txt",
        "hello",
        "*** Patch File: ./old.txt",
        "@@",
        "-old",
        "+new",
        "*** Move File: ./from.txt",
        "*** To: ./to.txt",
        "*** End Edit"
    ].join("\n"));
    assert.deepEqual(operations, [
        { body: "hello", kind: "write", path: "./new.txt" },
        { body: "@@\n-old\n+new", kind: "patch", path: "./old.txt" },
        { body: "", kind: "move", path: "./to.txt", source: "./from.txt" }
    ]);
});

test("Pi devshell Write File renders like native Pi write and has no success result block", () => {
    const args = {
        changes: [
            "*** Begin Edit",
            "*** Write File: ./tool-demo3.txt",
            "alpha",
            "",
            "beta",
            "*** End Edit"
        ].join("\n")
    };
    const callContext = context(args);
    const call = renderPiToolCall("file_edit", args, identityTheme, callContext);
    assert.deepEqual(visibleSelfLines(call), [
        "write ./tool-demo3.txt",
        "",
        "alpha",
        "",
        "beta"
    ]);

    const result = renderPiToolResult("file_edit", {
        content: [{ type: "text", text: "write ./tool-demo3.txt applied +3" }],
        details: {
            operations: [{
                action: "write",
                path: "./tool-demo3.txt",
                status: "applied",
                diff: "--- original\n+++ modified\n@@ -0,0 +1,3 @@\n+alpha\n+\n+beta\n"
            }]
        }
    }, { expanded: false, isPartial: false }, identityTheme, { ...callContext, lastComponent: undefined });

    assert.deepEqual(result.render(120), []);
    const after = visibleSelfLines(call);
    assert.deepEqual(after, ["write ./tool-demo3.txt", "", "alpha", "", "beta"]);
    assert.equal(after.join("\n").includes("***"), false);
    assert.equal(after.join("\n").includes("--- original"), false);
});

test("Pi devshell Patch File renders a separate stable native-style numbered diff result", () => {
    const args = {
        changes: [
            "*** Begin Edit",
            "*** Patch File: ./a.txt",
            "@@",
            "-old value",
            "+new value",
            "*** End Edit"
        ].join("\n")
    };
    const callContext = context(args);
    const call = renderPiToolCall("file_edit", args, identityTheme, callContext);

    const resultSlot = renderPiToolResult("file_edit", {
        content: [{ type: "text", text: "patch ./a.txt applied +1 -1" }],
        details: {
            operations: [{
                action: "patch",
                path: "./a.txt",
                status: "applied",
                diff: "--- original\n+++ modified\n@@ -10,3 +10,3 @@\n keep\n-old value\n+new value\n tail\n"
            }]
        }
    }, { expanded: false, isPartial: false }, identityTheme, { ...callContext, lastComponent: undefined });

    assert.deepEqual(visibleSelfLines(call), ["edit ./a.txt"]);
    assert.deepEqual(visibleSelfLines(resultSlot), [
        " 10 keep",
        "-11 [old] value",
        "+11 [new] value",
        " 12 tail"
    ]);
    const rendered = [...visibleSelfLines(call), ...visibleSelfLines(resultSlot)].join("\n");
    for (const marker of ["***", "--- original", "+++ modified", "@@"]) assert.equal(rendered.includes(marker), false);
});

test("Pi devshell file edit result rendering never invalidates or mutates its call slot", () => {
    const args = {
        changes: [
            "*** Begin Edit",
            "*** Patch File: ./a.txt",
            "@@",
            "-old value",
            "+new value",
            "*** End Edit"
        ].join("\n")
    };
    let invalidations = 0;
    const callContext = {
        ...context(args),
        invalidate() {
            invalidations += 1;
        }
    };
    const call = renderPiToolCall("file_edit", args, identityTheme, callContext);
    const before = visibleSelfLines(call);
    const result = {
        content: [{ type: "text", text: "patch ./a.txt applied +1 -1" }],
        details: {
            operations: [{
                action: "patch",
                path: "./a.txt",
                status: "applied",
                diff: "--- original\n+++ modified\n@@ -1 +1 @@\n-old value\n+new value\n"
            }]
        }
    };

    const first = renderPiToolResult(
        "file_edit",
        result,
        { expanded: false, isPartial: false },
        identityTheme,
        { ...callContext, lastComponent: undefined }
    );
    const second = renderPiToolResult(
        "file_edit",
        result,
        { expanded: false, isPartial: false },
        identityTheme,
        { ...callContext, lastComponent: first }
    );

    assert.deepEqual(visibleSelfLines(call), before);
    assert.deepEqual(visibleSelfLines(second), visibleSelfLines(first));
    assert.equal(invalidations, 0);
});

test("Pi devshell Worker unified diff adapter matches Pi numbered diff semantics", () => {
    assert.equal(
        renderWorkerUnifiedDiff(
            "--- original\n+++ modified\n@@ -3,2 +3,2 @@\n-old thing\n+new thing\n tail\n",
            identityTheme
        ),
        ["-3 [old] thing", "+3 [new] thing", " 4 tail"].join("\n")
    );
});
