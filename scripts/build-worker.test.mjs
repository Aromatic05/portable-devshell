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
                    [fixture.script, "--target", target.key],
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
    "build-worker rejects the removed --zigbuild switch",
    { skip },
    async () => {
        const fixture = await createFixture("x86_64-unknown-linux-musl");
        try {
            const result = spawnSync(
                process.execPath,
                [fixture.script, "--target", "linux-x64", "--zigbuild"],
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
            assert.match(
                result.stderr,
                /Linux targets always use cargo zigbuild/u,
            );
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

async function writeExecutable(path, body) {
    await writeFile(path, `#!/bin/sh\n${body}`, "utf8");
    await chmod(path, 0o755);
}

function valueAfter(values, name) {
    const index = values.indexOf(name);
    assert.notEqual(index, -1);
    return values[index + 1];
}
