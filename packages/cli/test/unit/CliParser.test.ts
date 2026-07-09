import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CliParser } from "../../dist/cli/CliParser.js";

test("CliParser parses Task 11 command fixture", async () => {
    const fixturePath = fileURLToPath(new URL("../fixtures/cli-argv.json", import.meta.url));
    const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as Array<{
        argv: string[];
        expected: Record<string, unknown>;
    }>;
    const parser = new CliParser();

    for (const entry of fixture) {
        assert.deepEqual(parser.parse(entry.argv), entry.expected);
    }
});

test("CliParser rejects invalid command shapes", () => {
    const parser = new CliParser();

    assert.throws(() => parser.parse(["instance", "call", "demo-local", "bash_run", "{bad"]), /valid JSON/u);
    assert.throws(() => parser.parse(["instance", "create", "demo-local"]), /Unexpected arguments/u);
    assert.throws(() => parser.parse(["instance", "logs", "demo-local", "--bad"]), /\[-f\]/u);
    assert.throws(() => parser.parse(["watch", "status"]), /requires <instance>/u);
});

test("Cli package exposes the Task 11 bin and runtime dependency contract", async () => {
    const packageJsonPath = fileURLToPath(new URL("../../package.json", import.meta.url));
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
        bin?: Record<string, string>;
        dependencies?: Record<string, string>;
    };

    assert.deepEqual(packageJson.bin, {
        devshell: "./dist/cli/CliMain.js"
    });
    assert.equal(packageJson.dependencies?.["@portable-devshell/shared"], "workspace:*");
    assert.equal(packageJson.dependencies?.["@portable-devshell/tui"], "workspace:*");
});
