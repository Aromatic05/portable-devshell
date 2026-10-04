import assert from "node:assert/strict";
import test from "node:test";

import { CONTROL_PROTOCOL_VERSION } from "@portable-devshell/shared";

import { CliMain } from "../../../src/app/Main.js";

test("secret cli.commands binding is dispatched with caller cwd", async () => {
    const calls: Array<{
        args: readonly string[];
        id: string;
        workingDirectory?: string;
    }> = [];
    const stdout = buffer();
    const stderr = buffer();
    const cli = new CliMain({
        createCliClients: () =>
            ({
                close() {},
                server: {
                    async hello() {
                        return {
                            capabilities: ["request", "stream", "streamResume"],
                            protocolVersion: CONTROL_PROTOCOL_VERSION,
                        };
                    },
                },
                cli: {
                    async command(
                        id: string,
                        args: readonly string[],
                        options?: { workingDirectory?: string },
                    ) {
                        calls.push({
                            id,
                            args,
                            workingDirectory: options?.workingDirectory,
                        });
                        return { kind: "json", value: { findings: [] } };
                    },
                    async commands() {
                        return [];
                    },
                },
            }) as never,
        stderr,
        stdout,
    });

    assert.equal(await cli.run(["secret", "scan", "."]), 0);
    assert.deepEqual(calls, [
        { id: "secret", args: ["scan", "."], workingDirectory: process.cwd() },
    ]);
    assert.match(stdout.flush(), /"findings": \[\]/u);
    assert.equal(stderr.flush(), "");
});

test("Extension json command result uses text rendering only in text output mode", async () => {
    const stdout = buffer();
    const stderr = buffer();
    const cli = new CliMain({
        createCliClients: () =>
            ({
                close() {},
                server: {
                    async hello() {
                        return {
                            capabilities: ["request", "stream", "streamResume"],
                            protocolVersion: CONTROL_PROTOCOL_VERSION,
                        };
                    },
                },
                cli: {
                    async command() {
                        return {
                            kind: "json",
                            text: "human readable",
                            value: { findings: [] },
                        };
                    },
                    async commands() {
                        return [];
                    },
                },
            }) as never,
        stderr,
        stdout,
    });

    assert.equal(await cli.run(["secret", "scan", "."]), 0);
    assert.equal(stdout.flush(), "human readable\n");

    assert.equal(
        await cli.run(["--output", "json", "secret", "scan", "."]),
        0,
    );
    assert.deepEqual(JSON.parse(stdout.flush()), { findings: [] });
    assert.equal(stderr.flush(), "");
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
        },
    };
}
