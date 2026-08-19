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

    assert.throws(() => parser.parse(["instance", "call", "demo-local", "bash_run", "{bad"]));
    assert.throws(() => parser.parse(["instance", "create", "demo-local"]));
    assert.throws(() => parser.parse(["instance", "logs", "demo-local", "--bad"]));
    assert.throws(() => parser.parse(["watch", "status"]));
    assert.throws(() => parser.parse(["unknown"]));
    assert.throws(() => parser.parse(["instance", "unknown"]));
});

test("CliParser accepts trailing help consistently across command levels", () => {
    const parser = new CliParser();

    assert.deepEqual(parser.parse(["status", "--help"]), { kind: "help" });
    assert.deepEqual(parser.parse(["instance", "status", "--help"]), { kind: "instance.help" });
    assert.deepEqual(parser.parse(["artifact", "share", "--help"]), { args: ["--help"], kind: "artifact" });
    assert.deepEqual(parser.parse(["config", "update", "--help"]), { kind: "help", topic: "config" });
    assert.deepEqual(parser.parse(["approval", "approve", "-h"]), { kind: "help", topic: "approval" });
});


test("CliParser routes artifact arguments through the normal command pipeline", () => {
    const parser = new CliParser();
    assert.deepEqual(parser.parse(["artifact", "transfer", "status", "transfer-1"]), {
        args: ["transfer", "status", "transfer-1"],
        kind: "artifact"
    });
});
