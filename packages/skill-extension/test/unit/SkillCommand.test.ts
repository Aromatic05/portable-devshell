import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
    ExtensionContext,
    ExtensionInvocationContext,
    ExtensionJsonValue,
    ExtensionWorkerPlatform
} from "@portable-devshell/extension";

import { executeSkillCommand } from "../../src/builtin/SkillCommand.ts";

function invocation(workingDirectory: string, localOwner = true): ExtensionInvocationContext {
    return {
        localOwner,
        requestId: "req-1",
        signal: new AbortController().signal,
        workingDirectory
    };
}

function context(options: {
    events: string[];
    platform?: ExtensionWorkerPlatform;
    shellResult?: ExtensionJsonValue;
    transferFailure?: Error;
}): ExtensionContext {
    const generation = `sha256-${"a".repeat(64)}`;
    return {
        assets: {
            async installBundle() { throw new Error("not used"); },
            async installDirectory(sourcePath) {
                options.events.push(`asset.install:${sourcePath}`);
                return { directory: "/asset", generation };
            },
            async listBundles() { return []; },
            async removeBundle() {},
            async resolveBundle() { return undefined; },
            async transferBundle(input) {
                options.events.push(`asset.transfer:${input.target.instance}:${input.target.workspace}:${input.target.path}:${input.overwrite}`);
                if (options.transferFailure !== undefined) throw options.transferFailure;
                return { transferId: "transfer-1", transferredBytes: 123 };
            }
        },
        generation: "g1",
        id: "skill",
        logger: {
            debug() {}, error() {}, info() {}, warn() {}
        },
        paths: {
            codeDirectory: "/code",
            dataDirectory: "/data",
            runtimeDirectory: "/runtime",
            stateDirectory: "/state"
        },
        version: "0.1.0",
        worker: {
            async openSession(input) {
                options.events.push(`worker.open:${input.instance}:${input.workspace}`);
                return {
                    environment: {
                        homeDirectory: options.platform?.os === "windows" ? "C:\\Users\\dev" : "/home/dev",
                        platform: options.platform ?? { arch: "x64", os: "linux" }
                    },
                    instance: input.instance ?? "local-one",
                    workspace: input.workspace,
                    async callTool(name, inputValue, callOptions) {
                        const record = inputValue as Record<string, ExtensionJsonValue>;
                        options.events.push(`worker.call:${name}:${String(record.command)}:${String(callOptions?.operationId)}`);
                        return options.shellResult ?? { exitCode: 0, stderr: "", stdout: "" };
                    },
                    async close() { options.events.push("worker.close"); },
                    listTools: () => [{ description: "Run shell", inputSchema: {}, name: "bash_run" }]
                };
            }
        }
    };
}

test("Skill command discovers project Skills from the local-owner CLI working directory", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "skill-extension-command-"));
    t.after(async () => await rm(root, { force: true, recursive: true }));
    const skillDirectory = join(root, ".agents", "skills", "review");
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(join(skillDirectory, "SKILL.md"), "---\ndescription: Review changes\n---\n# Review\n", "utf8");
    const events: string[] = [];

    const result = await executeSkillCommand(context({ events }), ["list"], invocation(root));

    assert.equal(result.kind, "json");
    const value = result.kind === "json" ? result.value as { skills: Array<{ description: string; name: string; source: string }> } : undefined;
    assert.deepEqual(
        value?.skills.find((skill) => skill.name === "review"),
        { description: "Review changes", name: "review", source: "project" }
    );
    assert.deepEqual(events, []);
});

test("Skill get snapshots one selected Skill, prepares Worker state, then transfers it through Artifact", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "skill-extension-get-"));
    t.after(async () => await rm(root, { force: true, recursive: true }));
    const skillDirectory = join(root, ".agents", "skills", "review");
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(join(skillDirectory, "SKILL.md"), "# Review\n\nReview changes.\n", "utf8");
    const events: string[] = [];

    const result = await executeSkillCommand(
        context({ events }),
        ["get", "review", "remote-one:/repo"],
        invocation(root)
    );

    assert.equal(result.kind, "json");
    assert.deepEqual(events, [
        `asset.install:${skillDirectory}`,
        "worker.open:remote-one:/repo",
        'worker.call:bash_run:mkdir -p -- "$HOME/.devshell/skill":skill.get.prepare',
        "asset.transfer:remote-one:/home/dev:./.devshell/skill/review:true",
        "worker.close"
    ]);
    assert.deepEqual(result.kind === "json" ? result.value : undefined, {
        generation: `sha256-${"a".repeat(64)}`,
        name: "review",
        source: "project",
        target: {
            instance: "remote-one",
            path: "./.devshell/skill/review",
            workspace: "/home/dev"
        },
        transfer: { transferId: "transfer-1", transferredBytes: 123 }
    });
});

test("Skill get uses PowerShell directory preparation on Windows Workers", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "skill-extension-windows-"));
    t.after(async () => await rm(root, { force: true, recursive: true }));
    const skillDirectory = join(root, ".agents", "skills", "review");
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(join(skillDirectory, "SKILL.md"), "# Review\n", "utf8");
    const events: string[] = [];

    await executeSkillCommand(
        context({ events, platform: { arch: "x64", os: "windows" } }),
        ["get", "review", "remote-one:C:\\repo"],
        invocation(root)
    );

    assert.equal(events.some((event) => event.includes("New-Item -ItemType Directory -Force")), true);
    assert.equal(events.some((event) => event.includes("asset.transfer:remote-one:C:\\Users\\dev:./.devshell/skill/review:true")), true);
});

test("Skill get closes the Worker session when preparation or transfer fails", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "skill-extension-failure-"));
    t.after(async () => await rm(root, { force: true, recursive: true }));
    const skillDirectory = join(root, ".agents", "skills", "review");
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(join(skillDirectory, "SKILL.md"), "# Review\n", "utf8");
    const events: string[] = [];

    await assert.rejects(
        executeSkillCommand(
            context({ events, shellResult: { exitCode: 2, stderr: "mkdir failed" } }),
            ["get", "review", "remote-one:/repo"],
            invocation(root)
        ),
        /mkdir failed/u
    );
    assert.equal(events.at(-1), "worker.close");
    assert.equal(events.some((event) => event.startsWith("asset.transfer:")), false);
});

test("Skill commands reject non-owner callers and invalid remote targets", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "skill-extension-authority-"));
    t.after(async () => await rm(root, { force: true, recursive: true }));
    const events: string[] = [];

    await assert.rejects(
        executeSkillCommand(context({ events }), ["list"], invocation(root, false)),
        /local owner CLI/u
    );
    await assert.rejects(
        executeSkillCommand(context({ events }), ["get", "review", "remote-one:relative"], invocation(root)),
        /workspace must be absolute/u
    );
});
