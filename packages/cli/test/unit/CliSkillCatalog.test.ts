import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
    listSkills,
    loadSkill,
    readSkillFile,
    searchSkills
} from "../../src/command/skill/CliCommandSkill.ts";

test("skill catalog layers project over managed over global without loading instructions", async () => {
    const root = await mkdtemp(join(tmpdir(), "devshell-skill-layers-"));
    try {
        const workspace = join(root, "workspace");
        const home = join(root, "home");
        const configHome = join(root, "config");
        await skill(workspace, ".agents/skills/review", "Project review", "PROJECT BODY");
        await skill(home, ".devshell/skill/review", "Managed review", "MANAGED BODY");
        await skill(home, ".devshell/skill/build", "Build packages", "BUILD BODY");
        await skill(configHome, "agents/skills/global-only", "Global helper", "GLOBAL BODY");

        const result = await listSkills({ configHome, home, workspace });

        assert.deepEqual(result.skills, [
            { description: "Build packages", name: "build", source: "managed" },
            { description: "Global helper", name: "global-only", source: "global" },
            { description: "Project review", name: "review", source: "project" }
        ]);
        assert.equal(JSON.stringify(result).includes("PROJECT BODY"), false);
        assert.equal(result.warnings.some((warning) => warning.includes("duplicate Skill 'review'")), true);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("skill search stays metadata-only while load discovers related files lazily", async () => {
    const root = await mkdtemp(join(tmpdir(), "devshell-skill-lazy-"));
    try {
        const workspace = join(root, "workspace");
        const home = join(root, "home");
        const configHome = join(root, "config");
        const directory = join(workspace, ".agents/skills/review");
        await skill(workspace, ".agents/skills/review", "Review pull requests", "Use the review workflow.");
        await mkdir(join(directory, "scripts"), { recursive: true });
        await writeFile(join(directory, "scripts/check.sh"), "#!/bin/sh\nprintf checked\n", "utf8");
        await writeFile(join(directory, "notes.md"), "extra notes\n", "utf8");

        const searched = await searchSkills("pull", { configHome, home, workspace });
        assert.deepEqual(searched.skills.map((entry) => entry.name), ["review"]);
        assert.equal("content" in searched.skills[0]!, false);
        assert.equal("relatedFiles" in searched.skills[0]!, false);

        const loaded = await loadSkill("review", { configHome, home, workspace });
        assert.equal(loaded.source, "project");
        assert.match(loaded.content, /Use the review workflow/u);
        assert.deepEqual(loaded.relatedFiles, ["notes.md", "scripts/check.sh"]);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("skill read loads one bounded related file and rejects SKILL.md", async () => {
    const root = await mkdtemp(join(tmpdir(), "devshell-skill-read-"));
    try {
        const workspace = join(root, "workspace");
        const home = join(root, "home");
        const configHome = join(root, "config");
        const directory = join(home, ".devshell/skill/build");
        await skill(home, ".devshell/skill/build", "Build helper", "Build instructions.");
        await mkdir(join(directory, "scripts"), { recursive: true });
        await writeFile(join(directory, "scripts/run.sh"), "#!/bin/sh\nprintf build\n", "utf8");

        const read = await readSkillFile("build", "scripts/run.sh", { configHome, home, workspace });
        assert.equal(read.source, "managed");
        assert.match(read.content, /printf build/u);
        await assert.rejects(
            readSkillFile("build", "SKILL.md", { configHome, home, workspace }),
            /skill load/u
        );
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

async function skill(base: string, relative: string, description: string, body: string): Promise<void> {
    const directory = join(base, relative);
    await mkdir(directory, { recursive: true });
    await writeFile(
        join(directory, "SKILL.md"),
        `---\ndescription: ${description}\n---\n# Skill\n\n${body}\n`,
        "utf8"
    );
}
