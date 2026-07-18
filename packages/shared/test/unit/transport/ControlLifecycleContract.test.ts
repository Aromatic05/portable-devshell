import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";

import {
    ControlDaemonLauncher,
    ControlLifecycleManager,
    ControlLogger,
    ControlPidFile,
    type ControlLifecycleRpcClient,
    type ControlPidFilePort,
    type ControlSocketFilePort
} from "@portable-devshell/shared";

test("control logger and pid file persist below the selected home and tolerate missing files", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "portable-devshell-shared-lifecycle-"));
    try {
        const logger = new ControlLogger(home);
        assert.equal(await logger.readAll(), "");
        await logger.info("started");
        await logger.error("failed");
        const logs = await logger.readAll();
        assert.match(logs, /INFO started/u);
        assert.match(logs, /ERROR failed/u);

        const pidFile = new ControlPidFile(home);
        assert.equal(await pidFile.read(), undefined);
        await pidFile.write(1234);
        assert.equal(await pidFile.read(), 1234);
        await writeFile(pidFile.path, "invalid\n", "utf8");
        assert.equal(await pidFile.read(), undefined);
        await pidFile.remove();
        assert.equal(await pidFile.read(), undefined);
    } finally {
        await rm(home, { force: true, recursive: true });
    }
});

test("control daemon launcher preserves bootstrap loaders and isolates daemon environment", () => {
    let recorded:
        | {
              args: string[];
              command: string;
              options: { detached?: boolean; env?: NodeJS.ProcessEnv; stdio?: unknown };
          }
        | undefined;
    let unrefCount = 0;

    const child = ControlDaemonLauncher.spawnDetached({
        daemonModulePath: "/app/ControlDaemon.js",
        env: { NODE_TEST_CONTEXT: "child-v8", PORTABLE_DEVSHELL_TEST: "yes" },
        homeDirectory: "/home/tester",
        spawnFunction(command, args, options) {
            recorded = { args, command, options };
            return Object.assign(new EventEmitter(), {
                unref() {
                    unrefCount += 1;
                }
            }) as never;
        },
        xdgRuntimeDir: "/run/tester"
    });

    assert.notEqual(child, undefined);
    assert.equal(recorded?.command, process.execPath);
    assert.equal(recorded?.args.at(-1), "/app/ControlDaemon.js");
    assert.equal(recorded?.options.detached, true);
    assert.equal(recorded?.options.stdio, "ignore");
    assert.equal(recorded?.options.env?.HOME, "/home/tester");
    assert.equal(recorded?.options.env?.XDG_RUNTIME_DIR, "/run/tester");
    assert.equal(recorded?.options.env?.PORTABLE_DEVSHELL_TEST, "yes");
    assert.equal(recorded?.options.env?.NODE_TEST_CONTEXT, undefined);
    assert.equal(unrefCount, 1);

    const bootstrap = recorded?.args.slice(0, -1) ?? [];
    assert.equal(bootstrap.includes("--experimental-transform-types"), process.execArgv.includes("--experimental-transform-types"));
    for (const argument of bootstrap) {
        assert.match(argument, /^(--experimental-transform-types|--import|--loader)(=|$)|^\.\/?|^file:|^[A-Za-z@][A-Za-z0-9@/._+-]*$/u);
    }
});

test("control lifecycle start is idempotent and stop tolerates the shutdown socket race", async () => {
    let running = false;
    let spawnCount = 0;
    let shutdownCount = 0;
    const pidActions: string[] = [];
    const socketActions: string[] = [];

    const rpcClient: ControlLifecycleRpcClient = {
        async request(operation) {
            if (operation === "shutdown") {
                shutdownCount += 1;
                running = false;
                throw new Error("socket closed before shutdown reply");
            }
            if (!running) {
                throw new Error("control unavailable");
            }
            return { instanceCount: 3 };
        }
    };
    const pidFile: ControlPidFilePort = {
        path: "/tmp/control.pid",
        async read() {
            return running ? 4321 : undefined;
        },
        async remove() {
            pidActions.push("remove");
        },
        async write(pid) {
            pidActions.push(`write:${pid ?? "default"}`);
        }
    };
    const socketFile: ControlSocketFilePort = {
        path: "/tmp/control.sock",
        runtimeDir: "/tmp",
        async ensureRuntimeDir() {
            socketActions.push("ensure");
        },
        async remove() {
            socketActions.push("remove");
        }
    };

    const lifecycle = new ControlLifecycleManager({
        daemonModulePath: "/app/ControlDaemon.js",
        logger: {
            path: "/tmp/control.log",
            async error() {},
            async info() {},
            async readAll() {
                return "";
            }
        },
        pidFile,
        rpcClient,
        socketFile,
        spawnFunction() {
            spawnCount += 1;
            running = true;
            return Object.assign(new EventEmitter(), { pid: 4321, unref() {} }) as never;
        },
        waitTimeoutMs: 100
    });

    assert.deepEqual(await lifecycle.start(), {
        instanceCount: 3,
        pid: 4321,
        running: true
    });
    assert.deepEqual(await lifecycle.start(), {
        instanceCount: 3,
        pid: 4321,
        running: true
    });
    assert.equal(spawnCount, 1);
    assert.deepEqual(pidActions, ["remove", "write:4321"]);
    assert.deepEqual(socketActions, ["remove", "ensure"]);

    assert.deepEqual(await lifecycle.stop(), {
        instanceCount: 0,
        pid: undefined,
        running: false
    });
    assert.equal(shutdownCount, 1);
    assert.deepEqual(pidActions, ["remove", "write:4321", "remove"]);
    assert.deepEqual(socketActions, ["remove", "ensure", "remove"]);
});

test("control lifecycle start failure includes the latest daemon log tail", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "portable-devshell-shared-start-failure-"));
    const pidPath = resolve(root, "control.pid");
    const socketPath = resolve(root, "control.sock");
    await mkdir(dirname(pidPath), { recursive: true });

    try {
        const lifecycle = new ControlLifecycleManager({
            daemonModulePath: "/app/ControlDaemon.js",
            logger: {
                path: resolve(root, "control.log"),
                async error() {},
                async info() {},
                async readAll() {
                    return "first\nlast diagnostic\n";
                }
            },
            pidFile: {
                path: pidPath,
                async read() {
                    return undefined;
                },
                async remove() {},
                async write() {}
            },
            rpcClient: {
                async request() {
                    throw new Error("offline");
                }
            },
            socketFile: {
                path: socketPath,
                runtimeDir: root,
                async ensureRuntimeDir() {},
                async remove() {}
            },
            processIsRunning: () => true,
            spawnFunction() {
                return Object.assign(new EventEmitter(), { pid: 999_999_999, unref() {} }) as never;
            },
            waitTimeoutMs: 1
        });

        await assert.rejects(
            lifecycle.start(),
            /control server did not become ready[\s\S]*control log:[\s\S]*last diagnostic/u
        );
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});
