import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionJsonValue } from "@portable-devshell/extension";

import { ExtensionProcessCapabilityControl } from "../../../src/control/extension/host/generation/capability/ExtensionProcessCapabilityControl.ts";

test("Extension processes capability refuses undeclared access before spawning", async () => {
    let spawns = 0;
    const capability = new ExtensionProcessCapabilityControl({
        allowed: false,
        extensionId: "example",
        generation: "g1",
        spawn() {
            spawns += 1;
            throw new Error("must not spawn");
        }
    });

    await assert.rejects(capability.start({ command: process.execPath }), /did not declare the processes capability/u);
    assert.equal(spawns, 0);
});

test("Extension managed process owns structured messages, stderr, and exit lifetime", async () => {
    const capability = new ExtensionProcessCapabilityControl({
        allowed: true,
        extensionId: "example",
        generation: "g1"
    });
    const managed = await capability.start({
        args: ["-e", [
            "process.stderr.write('ready\\n');",
            "process.on('message', (message) => {",
            "  if (message?.stop) process.exit(0);",
            "  process.send?.({ echoed: message });",
            "});"
        ].join("\n")],
        command: process.execPath,
        messages: true
    });
    const stderr = new Promise<string>((resolve) => {
        const remove = managed.onStderr((chunk) => {
            remove();
            resolve(chunk);
        });
    });
    const response = new Promise<ExtensionJsonValue>((resolve) => {
        const remove = managed.onMessage((message) => {
            remove();
            resolve(message);
        });
    });

    await managed.send({ hello: "world" });
    assert.match(await stderr, /ready/u);
    assert.deepEqual(await response, { echoed: { hello: "world" } });
    await managed.send({ stop: true });
    assert.deepEqual(await managed.closed, { code: 0 });
    await capability.closeAll();
});

test("Extension process generation cleanup terminates open processes and fences future starts", async () => {
    const capability = new ExtensionProcessCapabilityControl({
        allowed: true,
        extensionId: "example",
        generation: "g1"
    });
    const managed = await capability.start({
        args: ["-e", "setInterval(() => {}, 10_000);"],
        command: process.execPath
    });

    await capability.closeAll();
    const exit = await managed.closed;
    assert.equal(exit.signal, "SIGTERM");
    await assert.rejects(
        capability.start({ command: process.execPath }),
        /processes capability is closed/u
    );
});

test("Extension managed message process is reclaimed when its IPC channel disconnects", async () => {
    const capability = new ExtensionProcessCapabilityControl({
        allowed: true,
        extensionId: "example",
        generation: "g1"
    });
    const managed = await capability.start({
        args: ["-e", "process.disconnect(); setInterval(() => {}, 10_000);"],
        command: process.execPath,
        messages: true
    });

    const exit = await managed.closed;
    assert.equal(exit.signal, "SIGTERM");
    await capability.closeAll();
});
