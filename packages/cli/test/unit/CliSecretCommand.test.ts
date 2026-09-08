import assert from "node:assert/strict";
import test from "node:test";

import { CliMain } from "../../src/CliMain.ts";

test("secret command is dispatched through the generic Extension client with caller cwd", async () => {
    const calls: Array<{ args: readonly string[]; id: string; workingDirectory?: string }> = [];
    const stdout = buffer();
    const stderr = buffer();
    const cli = new CliMain({
        createCliClients: () => ({
            close() {},
            service: {
                async hello() {
                    return {
                        capabilities: ["request", "stream", "streamResume"],
                        protocolVersion: 1
                    };
                }
            },
            extension: {
                async command(id: string, args: readonly string[], options?: { workingDirectory?: string }) {
                    calls.push({ id, args, workingDirectory: options?.workingDirectory });
                    return { kind: "json", value: { findings: [] } };
                }
            }
        } as never),
        stderr,
        stdout
    });

    assert.equal(await cli.run(["secret", "scan", "."]), 0);
    assert.deepEqual(calls, [{ id: "secret", args: ["scan", "."], workingDirectory: process.cwd() }]);
    assert.match(stdout.flush(), /"findings": \[\]/u);
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
        }
    };
}
