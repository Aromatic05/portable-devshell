import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceScript = resolve(sourceRoot, "scripts", "build-worker.mjs");

for (const target of [
    {
        cargoSubcommand: "zigbuild",
        key: "linux-x64",
        rustTarget: "x86_64-unknown-linux-musl"
    },
    {
        cargoSubcommand: "build",
        key: "darwin-x64",
        rustTarget: "x86_64-apple-darwin"
    },
    {
        cargoSubcommand: "build",
        key: "windows-x64",
        rustTarget: "x86_64-pc-windows-msvc"
    }
]) {
    test(`build-worker uses cargo ${target.cargoSubcommand} for ${target.key}`, async () => {
        const fixture = await createFixture();
        try {
            const result = runFixture(fixture, [target.key]);
            assert.equal(result.status, 0, result.stderr || result.stdout);
            const cargoArgs = await readArgs(fixture.argsPath);
            assert.equal(cargoArgs[0], target.cargoSubcommand);
            assert.ok(cargoArgs.includes("--locked"));
            assert.ok(cargoArgs.includes("--release"));
            assert.equal(valueAfter(cargoArgs, "--target"), target.rustTarget);
        } finally {
            await rm(fixture.root, { force: true, recursive: true });
        }
    });
}

test("build-worker defaults to the host target when no target is provided", async () => {
    const target = hostTarget();
    const fixture = await createFixture();
    try {
        const result = runFixture(fixture, []);
        assert.equal(result.status, 0, result.stderr || result.stdout);
        const cargoArgs = await readArgs(fixture.argsPath);
        assert.equal(cargoArgs[0], target.cargoSubcommand);
        assert.equal(valueAfter(cargoArgs, "--target"), target.rustTarget);
        assert.ok(cargoArgs.includes("--release"));
    } finally {
        await rm(fixture.root, { force: true, recursive: true });
    }
});

test("build-worker rejects --target because targets are positional", async () => {
    const fixture = await createFixture();
    try {
        const result = runFixture(fixture, ["--target", "linux-x64"]);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /unsupported option: --target/u);
    } finally {
        await rm(fixture.root, { force: true, recursive: true });
    }
});

async function createFixture() {
    const root = await mkdtemp(resolve(tmpdir(), "portable-devshell-build-worker-"));
    const scriptsDirectory = resolve(root, "scripts");
    const script = resolve(scriptsDirectory, "build-worker.mjs");
    const cargoScript = resolve(root, "cargo-fake.mjs");
    const zigScript = resolve(root, "zig-fake.mjs");
    const argsPath = resolve(root, "cargo-args");
    await mkdir(scriptsDirectory, { recursive: true });
    await copyFile(sourceScript, script);
    await writeFile(resolve(root, "Cargo.toml"), "[workspace]\n", "utf8");
    await writeFakeCargo(cargoScript);
    await writeFile(zigScript, 'process.stdout.write("0.14.1\\n");\n', "utf8");
    return { argsPath, cargoScript, root, script, zigScript };
}

function runFixture(fixture, args) {
    return spawnSync(process.execPath, [fixture.script, ...args], {
        cwd: fixture.root,
        encoding: "utf8",
        env: {
            ...process.env,
            BUILD_WORKER_TEST_ROOT: fixture.root,
            PORTABLE_DEVSHELL_BUILD_CARGO: JSON.stringify([process.execPath, fixture.cargoScript]),
            PORTABLE_DEVSHELL_BUILD_ZIG: JSON.stringify([process.execPath, fixture.zigScript])
        },
        windowsHide: true
    });
}

async function writeFakeCargo(path) {
    await writeFile(path, `
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const args = process.argv.slice(2);
const root = process.env.BUILD_WORKER_TEST_ROOT;
if (!root) throw new Error("BUILD_WORKER_TEST_ROOT is required");
writeFileSync(resolve(root, "cargo-args"), args.join("\\n") + "\\n", "utf8");
if (args.includes("--version") || args[0] === "install") process.exit(0);
const targetIndex = args.indexOf("--target");
const target = targetIndex === -1 ? undefined : args[targetIndex + 1];
if (!target) throw new Error("missing --target");
const profile = args.includes("--release") ? "release" : "debug";
const output = resolve(root, "target", target, profile, target.includes("windows") ? "devshell-worker.exe" : "devshell-worker");
mkdirSync(resolve(output, ".."), { recursive: true });
writeFileSync(output, "worker", "utf8");
`, "utf8");
}

async function readArgs(path) {
    return (await readFile(path, "utf8")).trim().split("\n");
}

function hostTarget() {
    const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
    if (process.platform === "linux") {
        return { cargoSubcommand: "zigbuild", rustTarget: `${arch}-unknown-linux-musl` };
    }
    if (process.platform === "darwin") {
        return { cargoSubcommand: "build", rustTarget: `${arch}-apple-darwin` };
    }
    if (process.platform === "win32") {
        return { cargoSubcommand: "build", rustTarget: `${arch}-pc-windows-msvc` };
    }
    throw new Error(`unsupported host platform for build-worker test: ${process.platform}-${process.arch}`);
}

function valueAfter(values, name) {
    const index = values.indexOf(name);
    assert.notEqual(index, -1);
    return values[index + 1];
}
