import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { TuiAttachShellCommandResolver, TuiAttachShellResolutionError, TuiAttachShellRunner, editableProviderChoices, isTuiAttachShellSupported } from "../../dist/testing.js";

test("Attach Shell resolves a local login shell from control-provided instance data", () => {
    const command = new TuiAttachShellCommandResolver().resolve({
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

test("Windows supports Attach Shell only for SSH instances", () => {
    assert.equal(isTuiAttachShellSupported("local", "win32"), false);
    assert.equal(isTuiAttachShellSupported("docker", "win32"), false);
    assert.equal(isTuiAttachShellSupported("podman", "win32"), false);
    assert.equal(isTuiAttachShellSupported("reverse", "win32"), false);
    assert.equal(isTuiAttachShellSupported("ssh", "win32"), true);
});

test("Windows config choices do not advertise Docker or Podman providers", () => {
    assert.deepEqual(editableProviderChoices("win32"), ["local", "ssh"]);
    assert.deepEqual(editableProviderChoices("linux"), ["local", "ssh", "docker", "podman"]);
});

test("Attach Shell keeps the configured ssh command intact", () => {
    const command = new TuiAttachShellCommandResolver().resolve({
        configView: {
            instances: [{ name: "remote", provider: "ssh", ssh: { command: "ssh -p 2222 dev@example.test" } }]
        },
        instance: { name: "remote", provider: "ssh" }
    });

    assert.deepEqual(command, { args: ["-p", "2222", "dev@example.test"], command: "ssh" });
});

test("Attach Shell refuses a stopped container without starting it", () => {
    assert.throws(
        () => new TuiAttachShellCommandResolver().resolve({
            configView: {
                instances: [{ container: { containerName: "alpha", mode: "preset" }, name: "alpha", provider: "docker" }]
            },
            instance: { name: "alpha", provider: "docker" },
            snapshot: { daemonState: "stopped" } as never
        }),
        (error: unknown) => error instanceof TuiAttachShellResolutionError && error.message === "Container is not running. Use Start Worker first."
    );
});

test("Attach Shell probes a running container before opening its shell", () => {
    const command = new TuiAttachShellCommandResolver().resolve({
        configView: {
            instances: [{ container: { containerName: "alpha", mode: "preset" }, name: "alpha", provider: "docker" }]
        },
        instance: { name: "alpha", provider: "docker" },
        snapshot: { daemonState: "running" } as never
    });

    assert.deepEqual(command.readinessCheck, {
        args: ["inspect", "--format", "{{.State.Running}}", "alpha"],
        command: "docker",
        expectedOutput: "true"
    });
});

test("Attach Shell restores the TUI after a spawn failure", async () => {
    const lifecycle: string[] = [];
    const child = new EventEmitter();
    const runner = new TuiAttachShellRunner({
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

test("Attach Shell retries sh when a container bash exits with 127", async () => {
    const calls: string[][] = [];
    const runner = new TuiAttachShellRunner({
        hooks: { resume: () => undefined, suspend: () => undefined },
        spawn: (_command, args) => {
            calls.push([...args]);
            const child = new EventEmitter();
            queueMicrotask(() => child.emit("close", calls.length === 1 ? 127 : 0));
            return child as never;
        }
    });

    await runner.run({
        args: ["exec", "-it", "alpha", "bash"],
        command: "docker",
        fallbackCommands: [{ args: ["exec", "-it", "alpha", "sh"], command: "docker" }],
        fallbackOnExitCode: 127
    });

    assert.deepEqual(calls, [["exec", "-it", "alpha", "bash"], ["exec", "-it", "alpha", "sh"]]);
});

test("Attach Shell refuses a failed readiness probe before spawning an interactive shell", async () => {
    const commands: string[] = [];
    const runner = new TuiAttachShellRunner({
        hooks: { resume: () => undefined, suspend: () => undefined },
        spawn: (command) => {
            commands.push(command);
            const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter() });
            queueMicrotask(() => {
                child.stdout.emit("data", Buffer.from("false\n"));
                child.emit("close", 0);
            });
            return child as never;
        }
    });

    await assert.rejects(
        () => runner.run({
            args: ["exec", "-it", "alpha", "bash"],
            command: "docker",
            readinessCheck: { args: ["inspect", "--format", "{{.State.Running}}", "alpha"], command: "docker", expectedOutput: "true" }
        }),
        /Container is not running\. Use Start Worker first\./u
    );
    assert.deepEqual(commands, ["docker"]);
});
