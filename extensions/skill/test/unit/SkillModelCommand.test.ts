import assert from "node:assert/strict";
import test from "node:test";

import type {
    ExtensionContext,
    ExtensionJsonValue,
} from "@portable-devshell/extension";
import type { ExtensionWorkerSession } from "@portable-devshell/extension/worker";
import type { CliModelCommandInvocationContext } from "@portable-devshell/extension/cli";

import { executeSkillModelCommand } from "../../src/builtin/SkillModelCommand.ts";

function invocation(): CliModelCommandInvocationContext {
    return {
        context: {
            async instanceReference() {
                return { current: true };
            },
        },
        instance: "remote-one",
        requestId: "model-skill",
        signal: new AbortController().signal,
        workspace: "/remote/workspace",
    };
}

function context(calls: string[]): ExtensionContext {
    return {
        capabilities: {
            workerExecute: {
                async openSession(input): Promise<ExtensionWorkerSession> {
                    calls.push(`open:${input.instance}:${input.workspace}`);
                    return session(
                        calls,
                        input.instance ?? "",
                        input.workspace,
                    );
                },
            },
        },
        generation: "g1",
        id: "skill",
        logger: { debug() {}, error() {}, info() {}, warn() {} },
        paths: {
            codeDirectory: "/code",
            dataDirectory: "/data",
            runtimeDirectory: "/runtime",
            stateDirectory: "/state",
        },
        register() {},
        version: "0.1.0",
    };
}

function session(
    calls: string[],
    instance: string,
    workspace: string,
): ExtensionWorkerSession {
    return {
        closed: Promise.resolve(),
        environment: {
            homeDirectory: "/remote",
            platform: { arch: "x64", os: "linux" },
        },
        instance,
        workspace,
        async callTool(name, input): Promise<ExtensionJsonValue> {
            calls.push(`${name}:${JSON.stringify(input)}`);
            if (name === "file_glob") {
                const patterns =
                    (input as { patterns?: string[] }).patterns ?? [];
                if (patterns[0] === "./.agents/skills/*/SKILL.md") {
                    return {
                        entries: [
                            {
                                path: "./.agents/skills/review/SKILL.md",
                                type: "file",
                            },
                        ],
                    };
                }
                return {
                    entries: [
                        {
                            path: "./.agents/skills/review/references/checklist.md",
                            type: "file",
                        },
                    ],
                };
            }
            if (name === "file_read") {
                const request = asRecord(input);
                const requested = Array.isArray(request.files)
                    ? asRecord(request.files[0])
                    : {};
                const path =
                    typeof requested.path === "string"
                        ? requested.path
                        : "./.agents/skills/review/SKILL.md";
                if (
                    path === "./.agents/skills/review/references/checklist.md"
                ) {
                    return {
                        files: [
                            {
                                path,
                                error: {
                                    code: "file.readFailed",
                                    details: { path },
                                    message: "permission denied",
                                    retryable: false,
                                },
                            },
                        ],
                    };
                }
                return {
                    files: [
                        {
                            content:
                                "1:---\n2:description: Review remote changes\n3:---\n4:# Review",
                            path,
                        },
                    ],
                };
            }
            throw new Error(`unexpected tool ${name}`);
        },
        async close() {
            calls.push("close");
        },
        listTools: () => [],
    };
}

test("Skill model command discovers project Skills through the authoritative Worker workspace", async () => {
    const calls: string[] = [];
    const result = await executeSkillModelCommand(
        context(calls),
        ["list"],
        invocation(),
    );
    assert.equal(result.kind, "json");
    const value =
        result.kind === "json"
            ? (result.value as {
                  skills: Array<{
                      description: string;
                      name: string;
                      source: string;
                  }>;
              })
            : undefined;
    assert.deepEqual(
        value?.skills.find((skill) => skill.name === "review"),
        {
            description: "Review remote changes",
            name: "review",
            source: "project",
        },
    );
    assert.equal(calls[0], "open:remote-one:/remote/workspace");
    assert.equal(calls.at(-1), "close");
});

test("Skill model load reads the current Worker project Skill without Control cwd", async () => {
    const calls: string[] = [];
    const result = await executeSkillModelCommand(
        context(calls),
        ["load", "review"],
        invocation(),
    );
    assert.equal(result.kind, "json");
    const value =
        result.kind === "json"
            ? (result.value as { content: string; source: string })
            : undefined;
    assert.equal(value?.source, "project");
    assert.match(value?.content ?? "", /Review remote changes/u);
    assert.equal(calls[0], "open:remote-one:/remote/workspace");
});

test("Skill model read surfaces Worker batch error details", async () => {
    const calls: string[] = [];
    await assert.rejects(
        executeSkillModelCommand(
            context(calls),
            ["read", "review", "references/checklist.md"],
            invocation(),
        ),
        (error: unknown) => {
            assert.equal((error as { code?: string }).code, "file.readFailed");
            assert.equal((error as Error).message, "permission denied");
            assert.deepEqual((error as { details?: unknown }).details, {
                path: "./.agents/skills/review/references/checklist.md",
            });
            assert.equal((error as { retryable?: boolean }).retryable, false);
            return true;
        },
    );
    assert.equal(calls.at(-1), "close");
});

function asRecord(value: unknown): Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}
