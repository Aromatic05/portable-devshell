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
    assert.throws(() => parser.parse(["debug", "load", "worker:demo-local"]));
    assert.throws(() => parser.parse(["watch", "status"]));
    assert.throws(() => parser.parse(["Bad_Command"]));
    assert.throws(() => parser.parse(["instance", "unknown"]));
});

test("CliParser treats unknown top-level namespaces as cli.commands local ids", () => {
    const parser = new CliParser();

    assert.deepEqual(parser.parse(["agent", "start", "worker-a:/repo"]), {
        args: ["start", "worker-a:/repo"],
        commandId: "agent",
        kind: "cli.command"
    });
    assert.deepEqual(parser.parse(["agent", "--help"]), {
        args: ["--help"],
        commandId: "agent",
        kind: "cli.command"
    });
    assert.deepEqual(parser.parse(["extension"]), { kind: "extension.help" });
    assert.deepEqual(parser.parse(["extension", "list"]), { kind: "extension.list" });
    assert.deepEqual(parser.parse(["extension", "install", "./example.dsext"]), {
        kind: "extension.install",
        source: "./example.dsext"
    });
    assert.deepEqual(parser.parse(["extension", "update", "./example.dsext"]), {
        kind: "extension.install",
        source: "./example.dsext"
    });
    assert.deepEqual(parser.parse(["extension", "remove", "agent"]), {
        extensionId: "agent",
        kind: "extension.remove",
        purge: false
    });
    assert.deepEqual(parser.parse(["extension", "remove", "agent", "--purge"]), {
        extensionId: "agent",
        kind: "extension.remove",
        purge: true
    });
    assert.deepEqual(parser.parse(["extension", "inspect", "agent"]), {
        extensionId: "agent",
        kind: "extension.inspect"
    });
    assert.deepEqual(parser.parse(["extension", "enable", "agent"]), {
        extensionId: "agent",
        kind: "extension.enable"
    });
    assert.deepEqual(parser.parse(["extension", "disable", "agent"]), {
        extensionId: "agent",
        kind: "extension.disable"
    });
    assert.deepEqual(parser.parse(["extension", "reload", "agent"]), {
        extensionId: "agent",
        kind: "extension.reload"
    });
    assert.throws(() => parser.parse(["extension", "remove", "agent", "--unknown"]), /Unknown extension remove option/u);
});

test("CliParser accepts trailing help consistently across command levels", () => {
    const parser = new CliParser();

    assert.deepEqual(parser.parse(["status", "--help"]), { kind: "help" });
    assert.deepEqual(parser.parse(["instance", "status", "--help"]), { kind: "instance.help" });
    assert.deepEqual(parser.parse(["artifact", "share", "--help"]), {
        args: ["share", "--help"],
        commandId: "artifact",
        kind: "cli.command"
    });
    assert.deepEqual(parser.parse(["config", "update", "--help"]), { kind: "help", topic: "config" });
    assert.deepEqual(parser.parse(["debug", "load", "--help"]), { kind: "help", topic: "debug" });
    assert.deepEqual(parser.parse(["approval", "approve", "-h"]), { kind: "help", topic: "approval" });
    assert.deepEqual(parser.parse(["extension", "--help"]), { kind: "extension.help" });
});

test("CliParser accepts standard version flags", () => {
    const parser = new CliParser();

    assert.deepEqual(parser.parse(["--version"]), { kind: "version" });
    assert.deepEqual(parser.parse(["-V"]), { kind: "version" });
    assert.throws(() => parser.parse(["--version", "extra"]));
});

test("CliParser parses protected debug patch lifecycle commands", () => {
    const parser = new CliParser();

    assert.deepEqual(parser.parse(["debug", "targets"]), { kind: "debug.targets" });
    assert.deepEqual(parser.parse(["debug", "list"]), { kind: "debug.list" });
    assert.deepEqual(parser.parse(["debug", "load", "worker:demo-local", "./probe.js", "--ctx", "ctx-own"]), {
        ctxId: "ctx-own",
        file: "./probe.js",
        kind: "debug.load",
        target: "worker:demo-local",
    });
    assert.deepEqual(parser.parse([
        "debug", "load", "worker:demo-local", "./probe.js", "--ctx", "ctx-own", "--tool", "bash_run",
    ]), {
        ctxId: "ctx-own",
        file: "./probe.js",
        kind: "debug.load",
        target: "worker:demo-local",
        toolName: "bash_run",
    });
    assert.throws(() => parser.parse(["debug", "load", "worker:demo-local", "./probe.js"]));
    assert.deepEqual(parser.parse(["debug", "release", "debug-1"]), {
        kind: "debug.release",
        patchId: "debug-1",
    });
    assert.deepEqual(parser.parse(["debug", "unload", "debug-1"]), {
        kind: "debug.unload",
        patchId: "debug-1",
    });
});


test("CliParser routes artifact through the native Extension command pipeline", () => {
    const parser = new CliParser();
    assert.deepEqual(parser.parse(["artifact", "transfer", "status", "transfer-1"]), {
        args: ["transfer", "status", "transfer-1"],
        commandId: "artifact",
        kind: "cli.command"
    });
});
