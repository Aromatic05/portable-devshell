import assert from "node:assert/strict";
import test from "node:test";

import type {
    ExtensionContext,
    ExtensionJsonValue,
    ExtensionWorkerSession
} from "@portable-devshell/extension";
import type { CliModelCommandInvocationContext } from "@portable-devshell/extension/cli";

import { executeSkillModelCommand } from "../../src/builtin/SkillModelCommand.ts";

function invocation(): CliModelCommandInvocationContext {
    return {
        context: {
            async instanceReference() { return { current: true }; }
        },
        instance: "remote-one",
        requestId: "model-skill",
        signal: new AbortController().signal,
        workspace: "/remote/workspace"
    };
}

function context(calls: string[]): ExtensionContext {
    return {
        capabilities: {
            workers: {
                async openSession(input): Promise<ExtensionWorkerSession> {
                    calls.push(`open:${input.instance}:${input.workspace}`);
                    return session(calls, input.instance ?? "", input.workspace);
                }
            }
        },
        generation: "g1",
        id: "skill",
        logger: { debug() {}, error() {}, info() {}, warn() {} },
        paths: {
            codeDirectory: "/code",
            dataDirectory: "/data",
            runtimeDirectory: "/runtime",
            stateDirectory: "/state"
        },
        register() {},
        version: "0.1.0"
    };
}

function session(calls: string[], instance: string, workspace: string): ExtensionWorkerSession {
    return {
        closed: Promise.resolve(),
        environment: { homeDirectory: "/remote", platform: { arch: "x64", os: "linux" } },
        instance,
        workspace,
        async callTool(name, input): Promise<ExtensionJsonValue> {
            calls.push(`${name}:${JSON.stringify(input)}`);
            if (name === "file_find") {
                const paths = (input as { paths?: string[] }).paths ?? [];
                if (paths[0] === "./.agents/skills/*/SKILL.md") {
                    return { entries: [{ path: "./.agents/skills/review/SKILL.md", type: "file" }] };
                }
                return { entries: [{ path: "./.agents/skills/review/references/checklist.md", type: "file" }] };
            }
            if (name === "file_read") {
                if ("files" in (input as object)) {
                    return {
                        files: [{
                            content: "1:---\n2:description: Review remote changes\n3:---\n4:# Review",
                            path: "./.agents/skills/review/SKILL.md"
                        }]
                    };
                }
                return { content: "1:---\n2:description: Review remote changes\n3:---\n4:# Review" };
            }
            throw new Error(`unexpected tool ${name}`);
        },
        async close() { calls.push("close"); },
        listTools: () => []
    };
}

test("Skill model command discovers project Skills through the authoritative Worker workspace", async () => {
    const calls: string[] = [];
    const result = await executeSkillModelCommand(context(calls), ["list"], invocation());
    assert.equal(result.kind, "json");
    const value = result.kind === "json" ? result.value as {
        skills: Array<{ description: string; name: string; source: string }>;
    } : undefined;
    assert.deepEqual(value?.skills.find((skill) => skill.name === "review"), {
        description: "Review remote changes",
        name: "review",
        source: "project"
    });
    assert.equal(calls[0], "open:remote-one:/remote/workspace");
    assert.equal(calls.at(-1), "close");
});

test("Skill model load reads the current Worker project Skill without Control cwd", async () => {
    const calls: string[] = [];
    const result = await executeSkillModelCommand(context(calls), ["load", "review"], invocation());
    assert.equal(result.kind, "json");
    const value = result.kind === "json" ? result.value as { content: string; source: string } : undefined;
    assert.equal(value?.source, "project");
    assert.match(value?.content ?? "", /Review remote changes/u);
    assert.equal(calls[0], "open:remote-one:/remote/workspace");
});
