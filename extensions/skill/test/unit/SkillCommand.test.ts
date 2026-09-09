import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
    ExtensionContext,
    ExtensionInvocationContext
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
    projectionFailure?: Error;
}): ExtensionContext {
    const generation = `sha256-${"a".repeat(64)}`;
    return {
        capabilities: {
            assets: {
                async installBundle() { throw new Error("not used"); },
                async installDirectory(sourcePath) {
                    options.events.push(`asset.install:${sourcePath}`);
                    return { directory: "/asset", generation };
                },
                async listBundles() { return []; },
                async projectBundle(input) {
                    options.events.push(
                        `asset.project:${input.target.instance}:${input.target.collection}:${input.target.key}:${input.overwrite}`
                    );
                    if (options.projectionFailure !== undefined) throw options.projectionFailure;
                    return { transferId: "transfer-1", transferredBytes: 123 };
                },
                async removeBundle() {},
                async resolveBundle() { return undefined; }
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
        register() {},
        version: "0.1.0"
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

test("Skill get snapshots one selected Skill and projects it as an instance-scoped resource", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "skill-extension-get-"));
    t.after(async () => await rm(root, { force: true, recursive: true }));
    const skillDirectory = join(root, ".agents", "skills", "Review changes");
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(join(skillDirectory, "SKILL.md"), "# Review\n\nReview changes.\n", "utf8");
    const events: string[] = [];

    const result = await executeSkillCommand(
        context({ events }),
        ["get", "Review changes", "remote-one"],
        invocation(root)
    );

    assert.equal(result.kind, "json");
    assert.deepEqual(events, [
        `asset.install:${skillDirectory}`,
        "asset.project:remote-one:managed:Review changes:true"
    ]);
    assert.deepEqual(result.kind === "json" ? result.value : undefined, {
        generation: `sha256-${"a".repeat(64)}`,
        name: "Review changes",
        source: "project",
        target: {
            collection: "managed",
            instance: "remote-one",
            key: "Review changes"
        },
        transfer: { transferId: "transfer-1", transferredBytes: 123 }
    });
});

test("Skill get surfaces projection failure without opening a Worker tool session", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "skill-extension-failure-"));
    t.after(async () => await rm(root, { force: true, recursive: true }));
    const skillDirectory = join(root, ".agents", "skills", "review");
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(join(skillDirectory, "SKILL.md"), "# Review\n", "utf8");
    const events: string[] = [];

    await assert.rejects(
        executeSkillCommand(
            context({ events, projectionFailure: new Error("projection failed") }),
            ["get", "review", "remote-one"],
            invocation(root)
        ),
        /projection failed/u
    );
    assert.deepEqual(events, [
        `asset.install:${skillDirectory}`,
        "asset.project:remote-one:managed:review:true"
    ]);
});

test("Skill commands reject non-owner callers and invalid resource targets", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "skill-extension-authority-"));
    t.after(async () => await rm(root, { force: true, recursive: true }));
    const events: string[] = [];

    await assert.rejects(
        executeSkillCommand(context({ events }), ["list"], invocation(root, false)),
        /local owner CLI/u
    );
    await assert.rejects(
        executeSkillCommand(context({ events }), ["get", "review", "Bad_ID"], invocation(root)),
        /instance name is invalid/u
    );
});
