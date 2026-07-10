import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { AttachShellCommandResolver, AttachShellResolutionError, AttachShellRunner } from "../../dist/index.js";

test("Attach Shell resolves a local login shell from control-provided instance data", () => {
    const command = new AttachShellCommandResolver().resolve({
        environment: { SHELL: "/bin/zsh" },
        instance: { defaultWorkspace: "/workspace/alpha", name: "alpha", provider: "local" }
    });

    assert.deepEqual(command, {
        args: ["-l"],
        command: "/bin/zsh",
        cwd: "/workspace/alpha",
        fallbackCommands: [{ args: ["-l"], command: "bash" }, { args: ["-l"], command: "sh" }]
    });
});

test("Attach Shell keeps the configured ssh command intact", () => {
    const command = new AttachShellCommandResolver().resolve({
        configView: {
            instances: [{ name: "remote", provider: "ssh", ssh: { command: "ssh -p 2222 dev@example.test" } }]
        },
        instance: { name: "remote", provider: "ssh" }
    });

    assert.deepEqual(command, { args: ["-p", "2222", "dev@example.test"], command: "ssh" });
});

test("Attach Shell refuses a stopped container without starting it", () => {
    assert.throws(
        () => new AttachShellCommandResolver().resolve({
            configView: {
                instances: [{ container: { containerName: "alpha", mode: "preset" }, name: "alpha", provider: "docker" }]
            },
            instance: { name: "alpha", provider: "docker" },
            snapshot: { daemonState: "stopped" } as never
        }),
        (error: unknown) => error instanceof AttachShellResolutionError && error.message === "Container is not running. Use Start Worker first."
    );
});

test("Attach Shell restores the TUI after a spawn failure", async () => {
    const lifecycle: string[] = [];
    const child = new EventEmitter();
    const runner = new AttachShellRunner({
        hooks: {
            resume: () => lifecycle.push("resume"),
            suspend: () => lifecycle.push("suspend")
        },
        spawn: () => {
            queueMicrotask(() => child.emit("error", Object.assign(new Error("missing shell"), { code: "EACCES" })));
            return child as never;
        }
    });

    await assert.rejects(() => runner.run({ args: ["-l"], command: "missing-shell" }), /missing shell/u);
    assert.deepEqual(lifecycle, ["suspend", "resume"]);
});
