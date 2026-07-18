import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
    chmod,
    copyFile,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceScript = resolve(sourceRoot, "scripts", "build-worker.mjs");
const skip = process.platform === "win32";

for (const target of [
    {
        cargoSubcommand: "zigbuild",
        key: "linux-x64",
        rustTarget: "x86_64-unknown-linux-musl",
    },
    {
        cargoSubcommand: "build",
        key: "darwin-x64",
        rustTarget: "x86_64-apple-darwin",
    },
]) {
    test(
        `build-worker uses cargo ${target.cargoSubcommand} for ${target.key}`,
        { skip },
        async () => {
            const fixture = await createFixture(target.rustTarget);
            try {
                const result = spawnSync(
                    process.execPath,
                    [fixture.script, target.key],
                    {
                        cwd: fixture.root,
                        encoding: "utf8",
                        env: {
                            ...process.env,
                            BUILD_WORKER_TEST_ROOT: fixture.root,
                            BUILD_WORKER_TEST_TARGET: target.rustTarget,
                            PATH: `${fixture.binDirectory}${delimiter}${process.env.PATH ?? ""}`,
                        },
                    },
                );

                assert.equal(result.status, 0, result.stderr || result.stdout);
                const cargoArgs = (await readFile(fixture.argsPath, "utf8"))
                    .trim()
                    .split("\n");
                assert.equal(cargoArgs[0], target.cargoSubcommand);
                assert.ok(cargoArgs.includes("--locked"));
                assert.ok(cargoArgs.includes("--release"));
                assert.equal(
                    valueAfter(cargoArgs, "--target"),
                    target.rustTarget,
                );
            } finally {
                await rm(fixture.root, { force: true, recursive: true });
            }
        },
    );
}

test(
    "build-worker defaults to the host target when no target is provided",
    { skip },
    async () => {
        const target = hostTarget();
        const fixture = await createFixture(target.rustTarget);
        try {
            const result = spawnSync(
                process.execPath,
                [fixture.script],
                {
                    cwd: fixture.root,
                    encoding: "utf8",
                    env: {
                        ...process.env,
                        BUILD_WORKER_TEST_ROOT: fixture.root,
                        BUILD_WORKER_TEST_TARGET: target.rustTarget,
                        PATH: `${fixture.binDirectory}${delimiter}${process.env.PATH ?? ""}`,
                    },
                },
            );

            assert.equal(result.status, 0, result.stderr || result.stdout);
            const cargoArgs = (await readFile(fixture.argsPath, "utf8"))
                .trim()
                .split("\n");
            assert.equal(cargoArgs[0], target.cargoSubcommand);
            assert.equal(valueAfter(cargoArgs, "--target"), target.rustTarget);
            assert.ok(cargoArgs.includes("--release"));
        } finally {
            await rm(fixture.root, { force: true, recursive: true });
        }
    },
);

test(
    "build-worker rejects --target because targets are positional",
    { skip },
    async () => {
        const fixture = await createFixture("x86_64-unknown-linux-musl");
        try {
            const result = spawnSync(
                process.execPath,
                [fixture.script, "--target", "linux-x64"],
                {
                    cwd: fixture.root,
                    encoding: "utf8",
                    env: {
                        ...process.env,
                        PATH: `${fixture.binDirectory}${delimiter}${process.env.PATH ?? ""}`,
                    },
                },
            );

            assert.notEqual(result.status, 0);
            assert.match(result.stderr, /unsupported option: --target/u);
        } finally {
            await rm(fixture.root, { force: true, recursive: true });
        }
    },
);

async function createFixture(rustTarget) {
    const root = await mkdtemp(
        resolve(tmpdir(), "portable-devshell-build-worker-"),
    );
    const scriptsDirectory = resolve(root, "scripts");
    const binDirectory = resolve(root, "bin");
    const script = resolve(scriptsDirectory, "build-worker.mjs");
    const argsPath = resolve(root, "cargo-args");
    await mkdir(scriptsDirectory, { recursive: true });
    await mkdir(binDirectory, { recursive: true });
    await copyFile(sourceScript, script);
    await writeFile(resolve(root, "Cargo.toml"), "[workspace]\n", "utf8");
    await writeExecutable(
        resolve(binDirectory, "cargo"),
        [
            "set -eu",
            'printf "%s\\n" "$@" > "$BUILD_WORKER_TEST_ROOT/cargo-args"',
            "profile=debug",
            'case " $* " in *" --release "*) profile=release ;; esac',
            'mkdir -p "$BUILD_WORKER_TEST_ROOT/target/$BUILD_WORKER_TEST_TARGET/$profile"',
            'printf worker > "$BUILD_WORKER_TEST_ROOT/target/$BUILD_WORKER_TEST_TARGET/$profile/devshell-worker"',
        ].join("\n") + "\n",
    );
    return { argsPath, binDirectory, root, rustTarget, script };
}

function hostTarget() {
    if (process.platform === "linux") {
        return process.arch === "arm64"
            ? { cargoSubcommand: "zigbuild", rustTarget: "aarch64-unknown-linux-musl" }
            : { cargoSubcommand: "zigbuild", rustTarget: "x86_64-unknown-linux-musl" };
    }
    if (process.platform === "darwin") {
        return process.arch === "arm64"
            ? { cargoSubcommand: "build", rustTarget: "aarch64-apple-darwin" }
            : { cargoSubcommand: "build", rustTarget: "x86_64-apple-darwin" };
    }
    throw new Error(`unsupported host platform for build-worker test: ${process.platform}-${process.arch}`);
}

async function writeExecutable(path, body) {
    await writeFile(path, `#!/bin/sh\n${body}`, "utf8");
    await chmod(path, 0o755);
}

function valueAfter(values, name) {
    const index = values.indexOf(name);
    assert.notEqual(index, -1);
    return values[index + 1];
}
