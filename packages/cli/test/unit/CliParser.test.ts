import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CliParser } from "../../src/CliParser.ts";

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


test("CliParser routes artifact arguments through the normal command pipeline", () => {
    const parser = new CliParser();
    assert.deepEqual(parser.parse(["artifact", "transfer", "status", "transfer-1"]), {
        args: ["transfer", "status", "transfer-1"],
        kind: "artifact"
    });
});
