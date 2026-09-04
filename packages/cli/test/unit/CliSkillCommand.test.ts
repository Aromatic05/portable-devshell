import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CliMain } from "../../src/CliMain.ts";

test("skill catalog commands run locally without negotiating Control", async () => {
    const root = await mkdtemp(join(tmpdir(), "devshell-skill-cli-"));
    const workspace = join(root, "workspace");
    const home = join(root, "home");
    const skillDirectory = join(workspace, ".agents", "skills", "review");
    const stdout = buffer();
    const stderr = buffer();
    let helloCalls = 0;
    try {
        await mkdir(skillDirectory, { recursive: true });
        await writeFile(
            join(skillDirectory, "SKILL.md"),
            "---\ndescription: Review changes\n---\n# Review\n\nInspect the change.\n",
            "utf8"
        );
        const cli = new CliMain({
            createCliClients: () => ({
                close() {},
                async hello() {
                    helloCalls += 1;
                    throw new Error("skill commands must not contact Control");
                }
            } as never),
            homeDirectory: home,
            stderr,
            stdout
        });

        assert.equal(await cli.run(["skill", "list", "--workspace", workspace]), 0);
        assert.equal(helloCalls, 0);
        assert.equal(stderr.flush(), "");
        const listed = JSON.parse(stdout.flush()) as { skills: Array<{ name: string; source: string }> };
        assert.deepEqual(listed.skills, [{ description: "Review changes", name: "review", source: "project" }]);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

function buffer(): { flush(): string; write(chunk: string): void } {
    let content = "";
    return {
        flush() {
            const value = content;
            content = "";
            return value;
        },
        write(chunk: string) {
            content += chunk;
        }
    };
}
