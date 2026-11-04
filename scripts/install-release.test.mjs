import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { createRequire } from "node:module";
import {
    chmod,
    lstat,
    mkdir,
    open,
    readFile,
    readdir,
    readlink,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import { basename, resolve } from "node:path";
import test from "node:test";
import { pipeline } from "node:stream/promises";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createGzip, gunzipSync, gzipSync } from "node:zlib";
import { createTestTempDirectory } from "../test/TestTempDirectory.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const { pack } = createRequire(
    new URL("../packages/core/package.json", import.meta.url),
)("tar-stream");

// Use the workspace's JS tar writer: Windows tar.exe can crash while creating
// archives containing Unicode names, even with --format=gnutar. Extraction
// goes through the installer route: Node on Windows, system tar on Unix.
async function writeApplicationFixtureArchive(archive, directory) {
    const output = pack();
    const writing = pipeline(output, createGzip(), createWriteStream(archive));
    // Observe pipeline failures immediately, including while reading entries.
    writing.catch(() => {});
    try {
        async function append(relative = ".") {
            const path = resolve(directory, relative);
            const metadata = await lstat(path);
            assert.ok(metadata.isDirectory() || metadata.isFile());
            const data = metadata.isFile() ? await readFile(path) : undefined;
            await new Promise((resolveEntry, reject) => {
                output.entry(
                    {
                        name: relative,
                        type: metadata.isDirectory() ? "directory" : "file",
                        mode: metadata.mode & 0o777,
                        size: data?.length ?? 0,
                    },
                    data,
                    (error) => (error ? reject(error) : resolveEntry()),
                );
            });
            if (metadata.isDirectory()) {
                for (const name of (await readdir(path)).sort()) {
                    await append(`${relative}/${name}`);
                }
            }
        }
        await append();
        output.finalize();
        await writing;
    } catch (error) {
        output.destroy(error);
        await writing.catch(() => {});
        throw error;
    }
}

test("application fixture archive preserves Unicode archive path and members through release extraction", async () => {
    const root = await createTestTempDirectory("release-archive-test");
    const app = resolve(root, "源 空间");
    const destination = resolve(root, "解包 空间");
    const archive = resolve(root, "发布 应用.tar.gz");
    const member = "入口 空间/devshell-entry.js";
    const payload = Buffer.from("console.log('中文参数');\n");
    try {
        await mkdir(resolve(app, "入口 空间"), { recursive: true });
        await mkdir(destination);
        await writeFile(resolve(app, member), payload);
        await writeApplicationFixtureArchive(archive, app);
        if (process.platform === "win32") {
            // Execute the actual installer function under Windows PowerShell 5.1,
            // including its Unicode native argv and temporary Node script bridge.
            await runWindowsArchiveExtraction(root, archive, destination);
        } else {
            run("tar", ["-xzf", archive, "-C", destination]);
        }
        assert.deepEqual(await readFile(resolve(destination, member)), payload);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

async function windowsArchiveExtractor() {
    const source = await readFile(resolve(repositoryRoot, "scripts/install-release.ps1"), "utf8");
    const match = source.match(/function Expand-ApplicationArchive\([^]*?\n\}\n(?=\nfunction Set-InstallMetadata)/u);
    assert.ok(match, "installer extraction function must remain directly testable");
    const payload = match[0].match(/ {4}\$script = @'\r?\n([^]*?)\r?\n'@/u);
    assert.ok(payload);
    return { functionSource: match[0], payload: payload[1] };
}

async function runWindowsArchiveExtraction(root, archive, destination) {
    const { functionSource } = await windowsArchiveExtractor();
    const script = resolve(root, "extract.ps1");
    await writeFile(script, `\ufeffparam([string]$Archive, [string]$Destination)\n$ErrorActionPreference = "Stop"\n${functionSource}\nExpand-ApplicationArchive $Archive $Destination\n`);
    run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, archive, destination]);
}

async function runArchivePayload(root, archive, destination) {
    const { payload } = await windowsArchiveExtractor();
    const script = resolve(root, "extract.mjs");
    await writeFile(script, payload);
    return spawnSync(process.execPath, [script, archive, destination], {
        encoding: "utf8",
        timeout: 30_000,
    });
}

async function writeTarEntries(archive, entries) {
    const output = pack();
    const writing = pipeline(output, createGzip(), createWriteStream(archive));
    writing.catch(() => {});
    try {
        for (const { data = Buffer.alloc(0), ...header } of entries) {
            await new Promise((resolveEntry, reject) => {
                output.entry({ ...header, size: data.length }, data,
                    error => error ? reject(error) : resolveEntry());
            });
        }
        output.finalize();
        await writing;
    } catch (error) {
        output.destroy(error);
        await writing.catch(() => {});
        throw error;
    }
}

test("Windows installer Node extractor preserves UTF-8 PAX paths, long names and binary contents", async () => {
    const root = await createTestTempDirectory("windows-extractor-test");
    const archive = resolve(root, "发布 应用.tar.gz");
    const destination = resolve(root, "解包 空间");
    const names = ["入口 空间/devshell-entry.js", `${"a".repeat(120)}.js`, `${"prefix/".repeat(15)}entry.js`, "large.bin", "empty"];
    const payload = Buffer.from(Array.from({ length: 160_001 }, (_, index) => index % 256));
    try {
        await mkdir(destination);
        await writeTarEntries(archive, names.map(name => ({ name, data: name === "empty" ? Buffer.alloc(0) : payload })));
        const result = await runArchivePayload(root, archive, destination);
        assert.equal(result.status, 0, `${result.error?.stack ?? ""}\n${result.stdout}${result.stderr}`);
        for (const name of names) {
            assert.deepEqual(await readFile(resolve(destination, name)), name === "empty" ? Buffer.alloc(0) : payload);
        }
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("Windows installer Node extractor rejects traversal, Windows aliases, unsafe links and duplicate files", async () => {
    const root = await createTestTempDirectory("windows-extractor-safety-test");
    const archive = resolve(root, "archive.tar.gz");
    const destination = resolve(root, "app");
    const cases = [
        ...["../escape", "目录/../../escape", "/absolute", "C:/drive", "C:relative", "a\\..\\escape", "file:stream", "NUL.txt", "dir/COM1", "trailing. /file", "trailing./file"].map(name => [{ name }]),
        [{ name: "link", type: "symlink", linkname: "../outside" }],
        [{ name: "link", type: "link", linkname: "../outside" }],
        [{ name: "link", type: "link", linkname: "missing" }],
        [{ name: "original", data: Buffer.from("safe") }, { name: "link", type: "link", linkname: "original", pax: { linkpath: "../escape" } }],
        [{ name: "fifo", type: "fifo" }],
        [{ name: "innocent", pax: { path: "../escape" } }],
        [{ name: "same", data: Buffer.from("first") }, { name: "same", data: Buffer.from("second") }],
    ];
    try {
        for (const entries of cases) {
            await mkdir(destination);
            await writeTarEntries(archive, entries);
            const result = await runArchivePayload(root, archive, destination);
            assert.notEqual(result.status, 0, JSON.stringify(entries));
            assert.match(result.stderr, /Unsafe tar|Unsupported tar|EEXIST/u);
            await assert.rejects(lstat(resolve(root, "escape")), { code: "ENOENT" });
            await rm(destination, { recursive: true, force: true });
        }
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

function updateTarChecksum(header) {
    header.fill(32, 148, 156);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
}

test("Windows installer Node extractor handles GNU long names and materializes safe hardlinks", async () => {
    const root = await createTestTempDirectory("windows-extractor-gnu-test");
    const archive = resolve(root, "archive.tar.gz");
    const destination = resolve(root, "app");
    const longName = `${"long".repeat(35)}.js`;
    const payload = Buffer.from("GNU file contents\n");
    try {
        await mkdir(destination);
        await writeTarEntries(archive, [
            { name: "././@LongLink", data: Buffer.from(`${longName}\0`) },
            { name: "placeholder", data: payload },
            { name: "././@LongLink", data: Buffer.from(`${longName}\0`) },
            { name: "copy.js", type: "link", linkname: "placeholder" },
        ]);
        const tar = gunzipSync(await readFile(archive));
        tar[156] = "L".charCodeAt(0);
        updateTarChecksum(tar.subarray(0, 512));
        tar[2048 + 156] = "K".charCodeAt(0);
        updateTarChecksum(tar.subarray(2048, 2560));
        const fileHeader = tar.subarray(1024, 1536);
        fileHeader.write("ustar ", 257, "ascii");
        // GNU stores other metadata where USTAR stores the path prefix.
        fileHeader.write("1234567", 345, "ascii");
        updateTarChecksum(fileHeader);
        await writeFile(archive, gzipSync(tar));
        const result = await runArchivePayload(root, archive, destination);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(await readFile(resolve(destination, longName)), payload);
        assert.deepEqual(await readFile(resolve(destination, "copy.js")), payload);
        assert.equal((await lstat(resolve(destination, "copy.js"))).nlink, 1);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("Windows installer Node extractor rejects corrupt and truncated archives", async () => {
    const root = await createTestTempDirectory("windows-extractor-corrupt-test");
    const archive = resolve(root, "archive.tar.gz");
    const destination = resolve(root, "app");
    try {
        await writeTarEntries(archive, [{ name: "entry.js", data: Buffer.from("contents") }]);
        const gzip = await readFile(archive);
        const tar = gunzipSync(gzip);
        const badChecksum = Buffer.from(tar);
        badChecksum[0] ^= 1;
        const badCrc = Buffer.from(gzip);
        badCrc[badCrc.length - 8] ^= 1;
        for (const bytes of [gzipSync(badChecksum), gzipSync(tar.subarray(0, 514)), gzip.subarray(0, gzip.length - 5), badCrc]) {
            await mkdir(destination);
            await writeFile(archive, bytes);
            const result = await runArchivePayload(root, archive, destination);
            assert.notEqual(result.status, 0);
            assert.match(result.stderr, /Invalid tar checksum|Truncated tar archive|unexpected end|incorrect data check/u);
            await rm(destination, { recursive: true, force: true });
        }
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

// Model an external terminal without changing the installer ownership guard.
// Guard tests add their intentional Worker markers after this clean baseline.
function externalTerminalEnv() {
    const env = { ...process.env };
    delete env.DEVSHELL_WORKER_TOOL;
    delete env.DEVSHELL_MODEL_CTX_ID;
    delete env.DEVSHELL_MODEL_PARENT_CALL_ID;
    return env;
}

const allTargets = [
    "linux-x64",
    "linux-arm64",
    "darwin-x64",
    "darwin-arm64",
    "windows-x64",
    "windows-arm64",
];

test("Windows installer checks Worker ownership before any install work", async () => {
    const source = await readFile(resolve(repositoryRoot, "scripts", "install-release.ps1"), "utf8");
    const guard = source.indexOf("if ($env:DEVSHELL_WORKER_TOOL -or $env:DEVSHELL_MODEL_CTX_ID -or $env:DEVSHELL_MODEL_PARENT_CALL_ID)");
    assert.ok(guard >= 0 && guard < source.indexOf("$script:InstallStep = 0"));
});

test(
    "Windows installer rejects CLI Worker marker without MCP model context",
    { skip: process.platform !== "win32" },
    () => {
        const env = {
            ...externalTerminalEnv(),
            DEVSHELL_WORKER_TOOL: "1",
            PORTABLE_DEVSHELL_RELEASE_BASE_URL: "file:///nonexistent-worker-tool-release",
        };
        delete env.DEVSHELL_MODEL_CTX_ID;
        delete env.DEVSHELL_MODEL_PARENT_CALL_ID;
        const result = runInstallerRaw(env, true);
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /bash_run\/tmux_run/u);
        assert.doesNotMatch(result.stdout, /\[1\/6\]/u);
    },
);

test(
    "Unix installer rejects CLI Worker marker without MCP model context",
    { skip: process.platform === "win32" },
    () => {
        const env = {
            ...externalTerminalEnv(),
            DEVSHELL_WORKER_TOOL: "1",
            PORTABLE_DEVSHELL_RELEASE_BASE_URL: "file:///nonexistent-worker-tool-release",
        };
        delete env.DEVSHELL_MODEL_CTX_ID;
        delete env.DEVSHELL_MODEL_PARENT_CALL_ID;
        const result = runInstallerRaw(env, false);
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /不支持从 DevShell bash_run\/tmux_run 自升级/u);
        assert.match(result.stderr, /独立终端或 SSH/u);
        assert.equal(result.stdout, "");
    },
);

test(
    "Unix installer rejects Worker-owned self-upgrades before touching release assets",
    { skip: process.platform === "win32" },
    () => {
        const result = runInstallerRaw(
            {
                ...externalTerminalEnv(),
                DEVSHELL_MODEL_CTX_ID: "ctx-self-upgrade-test",
                DEVSHELL_MODEL_PARENT_CALL_ID: "call-self-upgrade-test",
                PORTABLE_DEVSHELL_RELEASE_BASE_URL: "file:///nonexistent-self-upgrade-release",
            },
            false,
        );
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /不支持从 DevShell bash_run\/tmux_run 自升级/u);
        assert.match(result.stderr, /独立终端或 SSH/u);
        assert.doesNotMatch(result.stdout, /\[1\/6\]/u);
    },
);

test(
    "Unix release installer activates the manifest-declared CLI and supports replacement",
    {
        skip: process.platform === "win32",
    },
    async () => {
        const root = await createTestTempDirectory("release-install-test");
        const release = resolve(root, "release");
        const app = resolve(root, "app");
        const home = resolve(root, "home");
        const installRoot = resolve(root, "installed");
        const binDirectory = resolve(root, "bin");
        const devshellHome = resolve(root, "devshell-home");
        const preflightLog = resolve(root, "preflight.jsonl");
        const applicationVersion = "9.8.7-test";

        try {
            await mkdir(resolve(app, "custom"), { recursive: true });
            await mkdir(release, { recursive: true });
            await mkdir(home, { recursive: true });
            await mkdir(binDirectory, { recursive: true });
            const preexistingPi = resolve(binDirectory, "pi");
            await writeFile(preexistingPi, "preexisting pi\n", "utf8");
            await writeFile(
                resolve(app, "package.json"),
                `${JSON.stringify(
                    {
                        name: "portable-devshell",
                        version: applicationVersion,
                        private: true,
                        type: "module",
                        bin: { devshell: "./custom/devshell-entry.js" },
                        engines: { node: ">=24" },
                    },
                    null,
                    2,
                )}\n`,
                "utf8",
            );
            await writeFile(
                resolve(app, "portable-devshell-install.json"),
                `${JSON.stringify(
                    {
                        minimumNodeMajor: 24,
                        updatePreflight: true,
                        version: applicationVersion,
                    },
                    null,
                    2,
                )}\n`,
                "utf8",
            );
            const preflightModule = resolve(
                app,
                "node_modules",
                "@portable-devshell",
                "control",
                "dist",
                "migration",
                "Control.js",
            );
            await mkdir(resolve(preflightModule, ".."), { recursive: true });
            await writeFile(
                resolve(
                    app,
                    "node_modules",
                    "@portable-devshell",
                    "control",
                    "package.json",
                ),
                '{"type":"module"}\n',
                "utf8",
            );
            await writeFile(
                preflightModule,
                [
                    'import { appendFileSync } from "node:fs";',
                    "export async function preflightControlUpdate(options = {}) {",
                    "  const log = process.env.PORTABLE_DEVSHELL_TEST_PREFLIGHT_LOG;",
                    "  if (log) appendFileSync(log, \`\${JSON.stringify({ currentApplicationDirectory: options.currentApplicationDirectory ?? null })}\\n\`);",
                    "  return { extensions: { checkedGenerations: 0 }, migration: { domains: [], required: false }, rollback: { blockers: [], feasible: true } };",
                    "}",
                    "",
                ].join("\n"),
                "utf8",
            );
            const cli = resolve(app, "custom", "devshell-entry.js");
            await writeFile(
                cli,
                [
                    "#!/usr/bin/env node",
                    "const command = process.argv[2] ?? 'status';",
                    "if (command === 'status') process.stdout.write('control: stopped\\n');",
                    "else if (command === 'stop') process.exit(0);",
                    "else { process.stderr.write(`unsupported test command: ${command}\\n`); process.exit(2); }",
                    "",
                ].join("\n"),
                "utf8",
            );
            await chmod(cli, 0o755);

            const archive = resolve(release, applicationAssetName());
            run("tar", ["-czf", archive, "-C", app, "."]);
            await writeChecksum(archive);

            for (const target of preinstalledTargets()) {
                const filename = target.startsWith("windows-")
                    ? `devshell-worker-${target}.exe`
                    : `devshell-worker-${target}`;
                const worker = resolve(release, filename);
                await writeFile(worker, `fake worker ${target}\n`, "utf8");
                await writeChecksum(worker);
            }

            const environment = {
                ...externalTerminalEnv(),
                HOME: home,
                XDG_DATA_HOME: resolve(root, "data"),
                PORTABLE_DEVSHELL_RELEASE_BASE_URL: pathToFileURL(
                    release,
                ).href.replace(/\/$/u, ""),
                PORTABLE_DEVSHELL_INSTALL_ROOT: installRoot,
                PORTABLE_DEVSHELL_BIN_DIR: binDirectory,
                PORTABLE_DEVSHELL_HOME: devshellHome,
                PORTABLE_DEVSHELL_TEST_PREFLIGHT_LOG: preflightLog,
            };

            runInstaller(environment);
            let preflights = (await readFile(preflightLog, "utf8"))
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line));
            assert.deepEqual(preflights, [
                { currentApplicationDirectory: null },
            ]);
            await assertInstalledLayout({
                applicationVersion,
                binDirectory,
                devshellHome,
                installRoot,
            });
            assert.equal(
                await readFile(preexistingPi, "utf8"),
                "preexisting pi\n",
            );

            runInstaller(environment);
            preflights = (await readFile(preflightLog, "utf8"))
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line));
            assert.deepEqual(preflights, [
                { currentApplicationDirectory: null },
                { currentApplicationDirectory: resolve(installRoot, "current") },
            ]);
            await assertInstalledLayout({
                applicationVersion,
                binDirectory,
                devshellHome,
                installRoot,
            });
            assert.equal(
                await readFile(preexistingPi, "utf8"),
                "preexisting pi\n",
            );
        } finally {
            await rm(root, { force: true, recursive: true });
        }
    },
);

test(
    "Unix release installer restores the Control and managed instances that were running before replacement",
    {
        skip: process.platform === "win32",
    },
    async () => {
        const root = await createTestTempDirectory(
            "release-runtime-restore-test",
        );
        const release = resolve(root, "release");
        const app = resolve(root, "app");
        const home = resolve(root, "home");
        const installRoot = resolve(root, "installed");
        const binDirectory = resolve(root, "bin");
        const devshellHome = resolve(root, "devshell-home");
        const calls = resolve(root, "calls.log");
        const applicationVersion = "9.8.7-runtime-restore";
        const hostTarget = preinstalledTargets()[0];
        const hostAsset = `devshell-worker-${hostTarget}`;
        const expectedWorkerSha = createHash("sha256")
            .update(`fake worker ${hostTarget}\n`)
            .digest("hex");
        const preparedWorker = resolve(
            devshellHome,
            "workers",
            hostTarget,
            expectedWorkerSha,
            "devshell-worker",
        );
        const oldVersionDirectory = resolve(
            installRoot,
            "versions",
            "9.8.6-old",
        );
        let oldControl;

        try {
            await mkdir(resolve(app, "custom"), { recursive: true });
            await mkdir(resolve(oldVersionDirectory, "custom"), {
                recursive: true,
            });
            await mkdir(release, { recursive: true });
            await mkdir(home, { recursive: true });
            await mkdir(resolve(devshellHome, "bin"), { recursive: true });
            await writeFile(resolve(devshellHome, "bin", hostAsset), "old-worker-alias\n");
            await writeFile(resolve(devshellHome, "bin", "devshell-worker"), "old-default-alias\n");

            const packageManifest = (packageVersion) =>
                `${JSON.stringify(
                    {
                        name: "portable-devshell",
                        version: packageVersion,
                        private: true,
                        type: "module",
                        bin: { devshell: "./custom/devshell-entry.js" },
                        engines: { node: ">=24" },
                    },
                    null,
                    2,
                )}\n`;
            await writeFile(
                resolve(oldVersionDirectory, "package.json"),
                packageManifest("9.8.6-old"),
                "utf8",
            );
            const oldCli = resolve(
                oldVersionDirectory,
                "custom",
                "devshell-entry.js",
            );
            await writeFile(
                oldCli,
                [
                    "#!/usr/bin/env node",
                    "import { appendFileSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';",
                    "import { resolve } from 'node:path';",
                    `const calls = ${JSON.stringify(calls)};`,
                    `const pidFile = ${JSON.stringify(resolve(devshellHome, "control", "control.pid"))};`,
                    `const workerPath = ${JSON.stringify(preparedWorker)};`,
                    `const devshellHome = ${JSON.stringify(devshellHome)};`,
                    `const installRoot = ${JSON.stringify(installRoot)};`,
                    `const hostAsset = ${JSON.stringify(hostAsset)};`,
                    "const command = process.argv[2] ?? 'status';",
                    "const pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10);",
                    "if (command === 'status') process.stdout.write(`control: running\\npid: ${pid}\\n`);",
                    "else if (command === 'overview') process.stdout.write(JSON.stringify({ instances: [",
                    "  { name: 'ready-local', snapshot: { daemonState: 'running' } },",
                    "  { name: 'starting-ssh', snapshot: { daemonState: 'starting' } },",
                    "  { name: 'stale-local', snapshot: { daemonState: 'stale' } },",
                    "  { name: 'stopped-local', snapshot: { daemonState: 'stopped' } },",
                    "  { name: 'reverse-node', snapshot: { daemonState: 'running', reverse: { connected: true } } }",
                    "] }));",
                    "else if (command === 'stop') {",
                    "  const backupReady = readdirSync(installRoot).filter(name => name.startsWith('.worker-activation-backup-')).some(name => existsSync(resolve(installRoot, name, hostAsset)) && existsSync(resolve(installRoot, name, 'devshell-worker')));",
                    "  appendFileSync(calls, `old:prepared:${existsSync(workerPath)}:${backupReady}\\n`);",
                    "  process.kill(pid, 'SIGTERM'); rmSync(pidFile, { force: true }); appendFileSync(calls, 'old:stop\\n');",
                    "}",
                    "else process.exit(2);",
                    "",
                ].join("\n"),
                "utf8",
            );
            await chmod(oldCli, 0o755);
            await symlink(
                "versions/9.8.6-old",
                resolve(installRoot, "current"),
            );
            oldControl = await startFakeControl(
                oldVersionDirectory,
                devshellHome,
            );

            await writeFile(
                resolve(app, "package.json"),
                packageManifest(applicationVersion),
                "utf8",
            );
            await writeFile(
                resolve(app, "portable-devshell-install.json"),
                `${JSON.stringify(
                    {
                        minimumNodeMajor: 24,
                        version: applicationVersion,
                    },
                    null,
                    2,
                )}\n`,
                "utf8",
            );
            const cli = resolve(app, "custom", "devshell-entry.js");
            await writeFile(
                cli,
                [
                    "#!/usr/bin/env node",
                    "import { appendFileSync } from 'node:fs';",
                    `const calls = ${JSON.stringify(calls)};`,
                    `const liveHome = ${JSON.stringify(devshellHome)};`,
                    "const command = process.argv[2] ?? 'status';",
                    "if (command === 'status') process.stdout.write(process.env.PORTABLE_DEVSHELL_HOME === liveHome ? 'control: running\\n' : 'control: stopped\\n');",
                    "else if (command === 'start') appendFileSync(calls, 'new:start\\n');",
                    "else if (command === 'instance' && process.argv[3] === 'start') appendFileSync(calls, `new:instance:${process.argv[4]}\\n`);",
                    "else process.exit(2);",
                    "",
                ].join("\n"),
                "utf8",
            );
            await chmod(cli, 0o755);

            const archive = resolve(release, applicationAssetName());
            run("tar", ["-czf", archive, "-C", app, "."]);
            await writeChecksum(archive);
            for (const target of preinstalledTargets()) {
                const worker = resolve(
                    release,
                    target.startsWith("windows-")
                        ? `devshell-worker-${target}.exe`
                        : `devshell-worker-${target}`,
                );
                await writeFile(worker, `fake worker ${target}\n`, "utf8");
                await writeChecksum(worker);
            }

            const result = runInstaller({
                ...externalTerminalEnv(),
                HOME: home,
                XDG_DATA_HOME: resolve(root, "data"),
                PORTABLE_DEVSHELL_RELEASE_BASE_URL: pathToFileURL(
                    release,
                ).href.replace(/\/$/u, ""),
                PORTABLE_DEVSHELL_INSTALL_ROOT: installRoot,
                PORTABLE_DEVSHELL_BIN_DIR: binDirectory,
                PORTABLE_DEVSHELL_HOME: devshellHome,
            });

            assert.deepEqual(
                (await readFile(calls, "utf8")).trim().split("\n"),
                [
                    "old:prepared:true:true",
                    "old:stop",
                    "new:start",
                    "new:instance:ready-local",
                    "new:instance:starting-ssh",
                    "new:instance:stale-local",
                ],
            );
            assert.match(result.stdout, /恢复.*3.*实例/u);
        } finally {
            oldControl?.kill("SIGKILL");
            await rm(root, { force: true, recursive: true });
        }
    },
);

test("Unix release installer stages workers and backs up aliases before shutdown, then atomically switches links", async () => {
    const source = (await readFile(resolve(repositoryRoot, "scripts", "install-release.sh"), "utf8"))
        .replace(/\r\n/gu, "\n");
    const workerPreparation = source.indexOf('    prepare_worker "$target"');
    const backupPreparation = source.indexOf("\nbackup_worker_aliases\n", workerPreparation);
    const shutdown = source.indexOf('if ! stop_installed_control "$current_cli"; then', backupPreparation);
    const activation = source.indexOf('replace_symlink "versions/$version" "$current_link"', shutdown);
    assert.ok(workerPreparation >= 0 && backupPreparation > workerPreparation);
    assert.ok(shutdown > backupPreparation, "Worker preparation and aliases backup must precede shutdown");
    assert.ok(activation > shutdown, "Application activation follows shutdown");
    assert.match(source, /renameSync\(process\.argv\[1\], process\.argv\[2\]\)/u);
    assert.doesNotMatch(source.slice(activation, source.indexOf('step "验证安装结果"', activation)), /rm -f "\$command_link"/u);
});

test(
    "Unix release installer rejects an application that cannot start before activation",
    {
        skip: process.platform === "win32",
    },
    async () => {
        const root = await createTestTempDirectory("release-broken-test");
        const release = resolve(root, "release");
        const app = resolve(root, "app");
        const home = resolve(root, "home");
        const installRoot = resolve(root, "installed");
        const binDirectory = resolve(root, "bin");
        const devshellHome = resolve(root, "devshell-home");

        try {
            await mkdir(resolve(app, "dist"), { recursive: true });
            await mkdir(release, { recursive: true });
            await mkdir(home, { recursive: true });
            await writeFile(
                resolve(app, "package.json"),
                `${JSON.stringify(
                    {
                        name: "portable-devshell",
                        version: "9.8.8-broken",
                        private: true,
                        type: "module",
                        bin: { devshell: "./dist/CliMain.js" },
                        engines: { node: ">=24" },
                    },
                    null,
                    2,
                )}\n`,
                "utf8",
            );
            await writeFile(
                resolve(app, "portable-devshell-install.json"),
                `${JSON.stringify(
                    {
                        minimumNodeMajor: 24,
                        version: "9.8.8-broken",
                    },
                    null,
                    2,
                )}\n`,
                "utf8",
            );
            const cli = resolve(app, "dist", "CliMain.js");
            await writeFile(
                cli,
                [
                    "#!/usr/bin/env node",
                    "import './missing-runtime-module.js';",
                    "",
                ].join("\n"),
                "utf8",
            );
            await chmod(cli, 0o755);

            const archive = resolve(release, applicationAssetName());
            run("tar", ["-czf", archive, "-C", app, "."]);
            await writeChecksum(archive);
            for (const target of preinstalledTargets()) {
                const filename = target.startsWith("windows-")
                    ? `devshell-worker-${target}.exe`
                    : `devshell-worker-${target}`;
                const worker = resolve(release, filename);
                await writeFile(worker, `fake worker ${target}\n`, "utf8");
                await writeChecksum(worker);
            }

            const result = spawnSync(
                "sh",
                [resolve(repositoryRoot, "scripts", "install-release.sh")],
                {
                    cwd: repositoryRoot,
                    encoding: "utf8",
                    env: {
                        ...externalTerminalEnv(),
                        HOME: home,
                        XDG_DATA_HOME: resolve(root, "data"),
                        PORTABLE_DEVSHELL_RELEASE_BASE_URL: pathToFileURL(
                            release,
                        ).href.replace(/\/$/u, ""),
                        PORTABLE_DEVSHELL_INSTALL_ROOT: installRoot,
                        PORTABLE_DEVSHELL_BIN_DIR: binDirectory,
                        PORTABLE_DEVSHELL_HOME: devshellHome,
                    },
                    timeout: 30_000,
                },
            );

            assert.notEqual(
                result.status,
                0,
                `${result.stdout}${result.stderr}`,
            );
            await assert.rejects(lstat(resolve(installRoot, "current")), {
                code: "ENOENT",
            });
        } finally {
            await rm(root, { force: true, recursive: true });
        }
    },
);

for (const unicode of [false, true]) {
    test(
        `Windows release installer activates and replaces an application (${unicode ? "Unicode paths" : "ASCII paths"})`,
        {
            skip: process.platform !== "win32",
        },
        async () => {
            const root = await createTestTempDirectory(
                "windows-release-install-test",
            );
            const release = resolve(root, "release");
            const app = resolve(root, "app");
            const home = resolve(root, unicode ? "用户 空间" : "home");
            const installRoot = resolve(
                root,
                unicode ? "安装 目录" : "installed",
            );
            const binDirectory = resolve(home, unicode ? "命令 目录" : "bin");
            const devshellHome = resolve(root, unicode ? "状态 空间" : "devshell-home");
            const applicationVersion = "9.8.7-windows-test";
            const cliDirectory = unicode ? "入口 空间" : "custom";

            try {
                await mkdir(resolve(app, cliDirectory), { recursive: true });
                await mkdir(release, { recursive: true });
                await mkdir(home, { recursive: true });
                await writeFile(
                    resolve(app, "package.json"),
                    `${JSON.stringify(
                        {
                            name: "portable-devshell",
                            version: applicationVersion,
                            private: true,
                            type: "module",
                            bin: {
                                devshell: `./${cliDirectory}/devshell-entry.js`,
                            },
                            engines: { node: ">=24" },
                        },
                        null,
                        2,
                    )}\n`,
                    "utf8",
                );
                await writeFile(
                    resolve(app, "portable-devshell-install.json"),
                    `${JSON.stringify(
                        {
                            minimumNodeMajor: 24,
                            version: applicationVersion,
                        },
                        null,
                        2,
                    )}\n`,
                    "utf8",
                );
                await writeFile(
                    resolve(app, cliDirectory, "devshell-entry.js"),
                    [
                        "#!/usr/bin/env node",
                        "const command = process.argv[2] ?? 'status';",
                        "if (command === 'status') process.stdout.write('control: stopped\\n');",
                        "else if (command === 'stop') process.exit(0);",
                        "else if (command === 'args') { process.stdout.write(JSON.stringify({ args: process.argv.slice(3), cwd: process.cwd() })); process.exit(17); }",
                        "else { process.stderr.write(`unsupported test command: ${command}\\n`); process.exit(2); }",
                        "",
                    ].join("\n"),
                    "utf8",
                );

                const archive = resolve(release, applicationAssetName());
                await writeApplicationFixtureArchive(archive, app);
                await writeChecksum(archive);
                for (const target of preinstalledTargets()) {
                    const filename = target.startsWith("windows-")
                        ? `devshell-worker-${target}.exe`
                        : `devshell-worker-${target}`;
                    const worker = resolve(release, filename);
                    await writeFile(worker, `fake worker ${target}\n`, "utf8");
                    await writeChecksum(worker);
                }

                const environment = {
                    ...externalTerminalEnv(),
                    HOME: home,
                    USERPROFILE: home,
                    LOCALAPPDATA: resolve(root, "local-app-data"),
                    PORTABLE_DEVSHELL_RELEASE_BASE_URL: pathToFileURL(
                        release,
                    ).href.replace(/\/$/u, ""),
                    PORTABLE_DEVSHELL_INSTALL_ROOT: installRoot,
                    PORTABLE_DEVSHELL_BIN_DIR: binDirectory,
                    PORTABLE_DEVSHELL_HOME: devshellHome,
                };
                const result = spawnSync(
                    "powershell.exe",
                    [
                        "-NoProfile",
                        "-NonInteractive",
                        "-ExecutionPolicy",
                        "Bypass",
                        "-File",
                        resolve(
                            repositoryRoot,
                            "scripts",
                            "install-release.ps1",
                        ),
                    ],
                    {
                        cwd: repositoryRoot,
                        encoding: "utf8",
                        env: environment,
                        timeout: 30_000,
                    },
                );
                assert.equal(
                    result.status,
                    0,
                    `${result.error?.stack ?? ""}\n${result.stdout}${result.stderr}`,
                );

                const command = resolve(binDirectory, "devshell.cmd");
                const bytes = await readFile(command);
                assert.ok(
                    bytes.every((byte) => byte < 128),
                    "batch source must be ASCII without a BOM",
                );
                for (const codepage of [437, 936, 65001]) {
                    const commandResult = spawnSync(
                        `chcp ${codepage} >nul && "%DEVSHELL_TEST_COMMAND%" status`,
                        {
                            cwd: home,
                            encoding: "utf8",
                            env: {
                                ...environment,
                                DEVSHELL_TEST_COMMAND: command,
                            },
                            shell: true,
                            timeout: 15_000,
                        },
                    );
                    assert.equal(
                        commandResult.status,
                        0,
                        `${commandResult.error ?? ""}\n${commandResult.stdout}${commandResult.stderr}`,
                    );
                    assert.match(commandResult.stdout, /control: stopped/u);
                }
                const argsResult = spawnSync(
                    '"%DEVSHELL_TEST_COMMAND%" args "two words" "中文参数"',
                    {
                        cwd: home,
                        encoding: "utf8",
                        env: { ...environment, DEVSHELL_TEST_COMMAND: command },
                        shell: true,
                        timeout: 15_000,
                    },
                );
                assert.equal(
                    argsResult.status,
                    17,
                    `${argsResult.stdout}${argsResult.stderr}`,
                );
                assert.deepEqual(JSON.parse(argsResult.stdout), {
                    args: ["two words", "中文参数"],
                    cwd: home,
                });
                const replaced = runInstallerRaw(environment, true);
                assert.equal(
                    replaced.status,
                    0,
                    `${replaced.stdout}${replaced.stderr}`,
                );
                assert.deepEqual(await readFile(command), bytes);
                await assert.rejects(lstat(resolve(binDirectory, "pi.cmd")), {
                    code: "ENOENT",
                });

                for (const target of preinstalledTargets()) {
                    const suffix = target.startsWith("windows-") ? ".exe" : "";
                    assert.equal(
                        (
                            await lstat(
                                resolve(
                                    devshellHome,
                                    "bin",
                                    `devshell-worker-${target}${suffix}`,
                                ),
                            )
                        ).isFile(),
                        true,
                    );
                }
                for (const target of allTargets.filter(
                    (candidate) => !preinstalledTargets().includes(candidate),
                )) {
                    const suffix = target.startsWith("windows-") ? ".exe" : "";
                    await assert.rejects(
                        lstat(
                            resolve(
                                devshellHome,
                                "bin",
                                `devshell-worker-${target}${suffix}`,
                            ),
                        ),
                        { code: "ENOENT" },
                    );
                }
            } finally {
                await rm(root, { force: true, recursive: true });
            }
        },
    );
}

async function assertInstalledLayout({
    applicationVersion,
    binDirectory,
    devshellHome,
    installRoot,
}) {
    const current = resolve(installRoot, "current");
    assert.equal(await readlink(current), `versions/${applicationVersion}`);

    const command = resolve(binDirectory, "devshell");
    const commandMetadata = await lstat(command);
    assert.equal(commandMetadata.isSymbolicLink(), true);
    assert.equal(
        await readlink(command),
        resolve(current, "custom", "devshell-entry.js"),
    );

    const result = spawnSync(command, ["status"], { encoding: "utf8" });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

    const installedManifest = JSON.parse(
        await readFile(resolve(current, "package.json"), "utf8"),
    );
    assert.equal(installedManifest.bin.devshell, "./custom/devshell-entry.js");
    assert.equal(installedManifest.bin.pi, undefined);
    assert.equal(installedManifest.version, applicationVersion);

    for (const target of preinstalledTargets()) {
        const suffix = target.startsWith("windows-") ? ".exe" : "";
        const worker = resolve(
            devshellHome,
            "bin",
            `devshell-worker-${target}${suffix}`,
        );
        assert.equal((await lstat(worker)).isSymbolicLink(), true);
    }
    for (const target of allTargets.filter(
        (candidate) => !preinstalledTargets().includes(candidate),
    )) {
        const suffix = target.startsWith("windows-") ? ".exe" : "";
        await assert.rejects(
            lstat(
                resolve(
                    devshellHome,
                    "bin",
                    `devshell-worker-${target}${suffix}`,
                ),
            ),
            { code: "ENOENT" },
        );
    }

    const installManifest = JSON.parse(
        await readFile(
            resolve(current, "portable-devshell-install.json"),
            "utf8",
        ),
    );
    assert.equal(typeof installManifest.workerReleaseDirectoryUrl, "string");
}

function runInstaller(environment) {
    const result = spawnSync(
        "sh",
        [resolve(repositoryRoot, "scripts", "install-release.sh")],
        {
            cwd: repositoryRoot,
            encoding: "utf8",
            env: environment,
            timeout: 30_000,
        },
    );
    assert.equal(
        result.status,
        0,
        `${result.error?.stack ?? ""}\n${result.stdout}${result.stderr}`,
    );
    return result;
}

async function writeChecksum(path) {
    const payload = await readFile(path);
    const sha256 = createHash("sha256").update(payload).digest("hex");
    await writeFile(`${path}.sha256`, `${sha256}  ${basename(path)}\n`, "utf8");
}

function hostTarget() {
    const os =
        process.platform === "win32"
            ? "windows"
            : process.platform === "darwin"
              ? "darwin"
              : "linux";
    const architecture = process.arch === "arm64" ? "arm64" : "x64";
    return `${os}-${architecture}`;
}

function preinstalledTargets() {
    return [hostTarget()];
}

function applicationAssetName() {
    return `portable-devshell-app-${hostTarget()}.tar.gz`;
}

function run(command, args) {
    const result = spawnSync(command, args, { encoding: "utf8" });
    assert.equal(
        result.status,
        0,
        `${result.error?.stack ?? ""}\n${result.stdout}${result.stderr}`,
    );
}

test(
    "Unix release installer rolls back application and worker aliases as one transaction",
    {
        skip: process.platform === "win32",
    },
    async () => {
        await verifyTransactionalRollback(false);
    },
);

test(
    "Unix release installer restores devshell after candidate failure without touching a preexisting pi command",
    {
        skip: process.platform === "win32",
    },
    async () => {
        const root = await createTestTempDirectory(
            "release-command-rollback-test",
        );
        const release = resolve(root, "release");
        const app = resolve(root, "app");
        const home = resolve(root, "home");
        const installRoot = resolve(root, "installed");
        const binDirectory = resolve(root, "bin");
        const devshellHome = resolve(root, "devshell-home");
        const environment = {
            ...externalTerminalEnv(),
            HOME: home,
            XDG_DATA_HOME: resolve(root, "data"),
            PORTABLE_DEVSHELL_RELEASE_BASE_URL: pathToFileURL(
                release,
            ).href.replace(/\/$/u, ""),
            PORTABLE_DEVSHELL_INSTALL_ROOT: installRoot,
            PORTABLE_DEVSHELL_BIN_DIR: binDirectory,
            PORTABLE_DEVSHELL_HOME: devshellHome,
        };
        try {
            await mkdir(binDirectory, { recursive: true });
            await writeFile(
                resolve(binDirectory, "devshell"),
                "original devshell\n",
                { mode: 0o755 },
            );
            await writeFile(resolve(binDirectory, "pi"), "original pi\n", {
                mode: 0o755,
            });
            await writeTransactionalReleaseFixture({
                app,
                failAfterActivation: true,
                release,
                version: "9.8.8-command-rollback",
                workerContent: "candidate-worker\n",
            });

            const failed = runInstallerRaw(environment, false);
            assert.notEqual(
                failed.status,
                0,
                `${failed.stdout}${failed.stderr}`,
            );
            assert.equal(
                await readFile(resolve(binDirectory, "devshell"), "utf8"),
                "original devshell\n",
            );
            assert.equal(
                await readFile(resolve(binDirectory, "pi"), "utf8"),
                "original pi\n",
            );
            assert.equal(
                (await lstat(resolve(binDirectory, "devshell"))).isFile(),
                true,
            );
            assert.equal(
                (await lstat(resolve(binDirectory, "pi"))).isFile(),
                true,
            );
        } finally {
            await rm(root, { force: true, recursive: true });
        }
    },
);

test(
    "Unix release installer restores the previous running runtime after rollback",
    {
        skip: process.platform === "win32",
    },
    async () => {
        const root = await createTestTempDirectory(
            "release-runtime-rollback-test",
        );
        const release = resolve(root, "release");
        const app = resolve(root, "app");
        const home = resolve(root, "home");
        const installRoot = resolve(root, "installed");
        const binDirectory = resolve(root, "bin");
        const devshellHome = resolve(root, "devshell-home");
        const runtimeLog = resolve(root, "runtime.log");
        let oldControl;
        const environment = {
            ...externalTerminalEnv(),
            HOME: home,
            XDG_DATA_HOME: resolve(root, "data"),
            PORTABLE_DEVSHELL_RELEASE_BASE_URL: pathToFileURL(
                release,
            ).href.replace(/\/$/u, ""),
            PORTABLE_DEVSHELL_INSTALL_ROOT: installRoot,
            PORTABLE_DEVSHELL_BIN_DIR: binDirectory,
            PORTABLE_DEVSHELL_HOME: devshellHome,
            PORTABLE_DEVSHELL_TEST_RUNTIME_LOG: runtimeLog,
        };

        try {
            await writeTransactionalReleaseFixture({
                app,
                release,
                version: "9.8.7-runtime-old",
                workerContent: "old-worker\n",
            });
            const installed = runInstallerRaw(environment, false);
            assert.equal(
                installed.status,
                0,
                `${installed.stdout}${installed.stderr}`,
            );

            const oldVersionDirectory = resolve(
                installRoot,
                "versions",
                "9.8.7-runtime-old",
            );
            oldControl = await startFakeControl(
                oldVersionDirectory,
                devshellHome,
            );
            await writeTransactionalReleaseFixture({
                app,
                failAfterActivation: true,
                release,
                version: "9.8.8-runtime-broken",
                workerContent: "new-worker\n",
            });
            const failed = runInstallerRaw(
                {
                    ...environment,
                    PORTABLE_DEVSHELL_TEST_RUNNING: "1",
                    PORTABLE_DEVSHELL_TEST_LIVE_HOME: devshellHome,
                },
                false,
            );
            assert.notEqual(
                failed.status,
                0,
                `${failed.stdout}${failed.stderr}`,
            );
            assert.deepEqual(
                (await readFile(runtimeLog, "utf8")).trim().split("\n"),
                [
                    "stop",
                    "start",
                    "instance:ready-local",
                    "instance:starting-ssh",
                    "instance:stale-local",
                ],
            );
            const restored = JSON.parse(
                await readFile(
                    resolve(installRoot, "current", "package.json"),
                    "utf8",
                ),
            );
            assert.equal(restored.version, "9.8.7-runtime-old");
        } finally {
            oldControl?.kill("SIGKILL");
            await rm(root, { force: true, recursive: true });
        }
    },
);

test(
    "Unix release installer rejects stale activation before stopping a different running Control",
    {
        skip: process.platform === "win32",
    },
    async () => {
        const root = await createTestTempDirectory(
            "release-stale-activation-test",
        );
        const release = resolve(root, "release");
        const app = resolve(root, "app");
        const home = resolve(root, "home");
        const installRoot = resolve(root, "installed");
        const binDirectory = resolve(root, "bin");
        const devshellHome = resolve(root, "devshell-home");
        const runtimeLog = resolve(root, "runtime.log");
        const environment = {
            ...externalTerminalEnv(),
            HOME: home,
            XDG_DATA_HOME: resolve(root, "data"),
            PORTABLE_DEVSHELL_RELEASE_BASE_URL: pathToFileURL(
                release,
            ).href.replace(/\/$/u, ""),
            PORTABLE_DEVSHELL_INSTALL_ROOT: installRoot,
            PORTABLE_DEVSHELL_BIN_DIR: binDirectory,
            PORTABLE_DEVSHELL_HOME: devshellHome,
            PORTABLE_DEVSHELL_TEST_RUNTIME_LOG: runtimeLog,
        };
        let liveControl;
        try {
            await writeTransactionalReleaseFixture({
                app,
                release,
                version: "9.8.7-activated",
                workerContent: "old-worker\n",
            });
            const installed = runInstallerRaw(environment, false);
            assert.equal(
                installed.status,
                0,
                `${installed.stdout}${installed.stderr}`,
            );

            const liveGeneration = resolve(
                installRoot,
                "versions",
                "9.8.9-actually-running",
            );
            liveControl = await startFakeControl(liveGeneration, devshellHome);
            await writeTransactionalReleaseFixture({
                app,
                release,
                version: "9.9.0-candidate",
                workerContent: "new-worker\n",
            });

            const failed = runInstallerRaw(
                {
                    ...environment,
                    PORTABLE_DEVSHELL_TEST_RUNNING: "1",
                    PORTABLE_DEVSHELL_TEST_LIVE_HOME: devshellHome,
                },
                false,
            );
            assert.notEqual(
                failed.status,
                0,
                `${failed.stdout}${failed.stderr}`,
            );
            assert.match(
                failed.stderr,
                /不属于当前激活的 application generation/u,
            );
            const current = JSON.parse(
                await readFile(
                    resolve(installRoot, "current", "package.json"),
                    "utf8",
                ),
            );
            assert.equal(current.version, "9.8.7-activated");
            assert.equal(
                await readFile(runtimeLog, "utf8").catch(() => ""),
                "",
            );
            assert.doesNotThrow(() => process.kill(liveControl.pid, 0));
        } finally {
            liveControl?.kill("SIGKILL");
            await rm(root, { force: true, recursive: true });
        }
    },
);

test(
    "Unix release installer rolls back when the candidate Control cannot restore real state",
    {
        skip: process.platform === "win32",
    },
    async () => {
        const root = await createTestTempDirectory(
            "release-real-runtime-failure-test",
        );
        const release = resolve(root, "release");
        const app = resolve(root, "app");
        const home = resolve(root, "home");
        const installRoot = resolve(root, "installed");
        const binDirectory = resolve(root, "bin");
        const devshellHome = resolve(root, "devshell-home");
        const runtimeLog = resolve(root, "runtime.log");
        const environment = {
            ...externalTerminalEnv(),
            HOME: home,
            XDG_DATA_HOME: resolve(root, "data"),
            PORTABLE_DEVSHELL_RELEASE_BASE_URL: pathToFileURL(
                release,
            ).href.replace(/\/$/u, ""),
            PORTABLE_DEVSHELL_INSTALL_ROOT: installRoot,
            PORTABLE_DEVSHELL_BIN_DIR: binDirectory,
            PORTABLE_DEVSHELL_HOME: devshellHome,
            PORTABLE_DEVSHELL_TEST_LIVE_HOME: devshellHome,
            PORTABLE_DEVSHELL_TEST_RUNTIME_LOG: runtimeLog,
        };
        let oldControl;
        try {
            await writeTransactionalReleaseFixture({
                app,
                release,
                version: "9.8.7-runtime-old",
                workerContent: "old-worker\n",
            });
            const installed = runInstallerRaw(environment, false);
            assert.equal(
                installed.status,
                0,
                `${installed.stdout}${installed.stderr}`,
            );

            oldControl = await startFakeControl(
                resolve(installRoot, "versions", "9.8.7-runtime-old"),
                devshellHome,
            );
            await writeTransactionalReleaseFixture({
                app,
                failRuntimeRestore: true,
                release,
                version: "9.8.8-runtime-new",
                workerContent: "new-worker\n",
            });
            const failed = runInstallerRaw(
                {
                    ...environment,
                    PORTABLE_DEVSHELL_TEST_RUNNING: "1",
                },
                false,
            );
            assert.notEqual(
                failed.status,
                0,
                `${failed.stdout}${failed.stderr}`,
            );
            assert.match(failed.stderr, /候选 Control 无法恢复真实运行态/u);
            const current = JSON.parse(
                await readFile(
                    resolve(installRoot, "current", "package.json"),
                    "utf8",
                ),
            );
            assert.equal(current.version, "9.8.7-runtime-old");
            assert.deepEqual(
                (await readFile(runtimeLog, "utf8")).trim().split("\n"),
                [
                    "stop",
                    "candidate-start-failed",
                    "stop",
                    "start",
                    "instance:ready-local",
                    "instance:starting-ssh",
                    "instance:stale-local",
                ],
            );
            const workerBackups = (await readdir(installRoot)).filter((name) =>
                name.startsWith(".worker-activation-backup-"),
            );
            assert.equal(workerBackups.length, 0);
        } finally {
            oldControl?.kill("SIGKILL");
            await rm(root, { force: true, recursive: true });
        }
    },
);

test(
    "Unix release installer restores the previous version on instance failure with no explicit schema migration",
    {
        skip: process.platform === "win32",
    },
    async () => {
        const root = await createTestTempDirectory(
            "release-instance-runtime-failure-test",
        );
        const release = resolve(root, "release");
        const app = resolve(root, "app");
        const home = resolve(root, "home");
        const installRoot = resolve(root, "installed");
        const binDirectory = resolve(root, "bin");
        const devshellHome = resolve(root, "devshell-home");
        const runtimeLog = resolve(root, "runtime.log");
        const environment = {
            ...externalTerminalEnv(),
            HOME: home,
            XDG_DATA_HOME: resolve(root, "data"),
            PORTABLE_DEVSHELL_RELEASE_BASE_URL: pathToFileURL(
                release,
            ).href.replace(/\/$/u, ""),
            PORTABLE_DEVSHELL_INSTALL_ROOT: installRoot,
            PORTABLE_DEVSHELL_BIN_DIR: binDirectory,
            PORTABLE_DEVSHELL_HOME: devshellHome,
            PORTABLE_DEVSHELL_TEST_LIVE_HOME: devshellHome,
            PORTABLE_DEVSHELL_TEST_RUNTIME_LOG: runtimeLog,
        };
        let oldControl;
        try {
            await writeTransactionalReleaseFixture({
                app,
                release,
                version: "9.8.7-instance-old",
                workerContent: "old-worker\n",
            });
            const installed = runInstallerRaw(environment, false);
            assert.equal(
                installed.status,
                0,
                `${installed.stdout}${installed.stderr}`,
            );

            oldControl = await startFakeControl(
                resolve(installRoot, "versions", "9.8.7-instance-old"),
                devshellHome,
            );
            const persistentMarker = resolve(devshellHome, "data-before-upgrade.txt");
            await writeFile(persistentMarker, "original-state\n");
            await writeTransactionalReleaseFixture({
                app,
                failInstanceRestore: true,
                release,
                version: "9.8.8-instance-new",
                workerContent: "new-worker\n",
            });
            const failed = runInstallerRaw(
                {
                    ...environment,
                    PORTABLE_DEVSHELL_TEST_RUNNING: "1",
                },
                false,
            );
            assert.notEqual(
                failed.status,
                0,
                `${failed.stdout}${failed.stderr}`,
            );
            assert.match(failed.stderr, /恢复旧程序及持久状态/u);
            const current = JSON.parse(
                await readFile(
                    resolve(installRoot, "current", "package.json"),
                    "utf8",
                ),
            );
            assert.equal(current.version, "9.8.7-instance-old");
            assert.equal(await readFile(persistentMarker, "utf8"), "original-state\n");
            const runtimeEvents = (await readFile(runtimeLog, "utf8"))
                .trim().split("\n");
            assert.deepEqual(runtimeEvents.slice(0, 5), [
                "stop",
                "start",
                "instance:ready-local",
                "instance:starting-ssh",
                "instance:stale-local",
            ]);
            assert.ok(runtimeEvents.slice(5).includes("stop"));
            assert.ok(runtimeEvents.slice(5).includes("start"));
            const workerBackups = (await readdir(installRoot)).filter((name) =>
                name.startsWith(".worker-activation-backup-"),
            );
            assert.equal(workerBackups.length, 0);
        } finally {
            oldControl?.kill("SIGKILL");
            await rm(root, { force: true, recursive: true });
        }
    },
);

test(
    "Windows release installer rolls back application and worker aliases as one transaction",
    {
        skip: process.platform !== "win32",
    },
    async () => {
        await verifyTransactionalRollback(true);
    },
);

for (const [label, bytes] of [
    [
        "UTF-8 BOM and Unicode without final newline",
        Buffer.from("\ufeff@echo off\r\nrem 原命令"),
    ],
    [
        "legacy codepage bytes",
        Buffer.from([
            0x40, 0x72, 0x65, 0x6d, 0x20, 0xd6, 0xd0, 0xce, 0xc4, 0x0d, 0x0a,
        ]),
    ],
    ["empty command", Buffer.alloc(0)],
]) {
    test(
        `Windows installer restores exact previous CMD bytes: ${label}`,
        { skip: process.platform !== "win32" },
        async () => {
            await verifyTransactionalRollback(true, bytes);
        },
    );
}

test("Windows release installer blocks rollback before starting a migration child", async () => {
    const source = await readFile(resolve(repositoryRoot, "scripts", "install-release.ps1"), "utf8");
    const started = source.indexOf("            $migrationStarted = $true");
    const child = source.indexOf("& node $cliPath migrate", started);
    const committed = source.indexOf("            $migrationCommitted = $true", child);
    assert.ok(started > source.indexOf("        if ($migrationRequired) {"));
    assert.ok(child > started);
    assert.ok(committed > child);
    assert.match(source, /if \(-not \$activated -and -not \$migrationStarted\) \{/u);
    assert.doesNotMatch(source.slice(started, committed), /\$activated = \$true|\$runtimeWasStopped = \$false/u);
});

test(
    "Windows release installer preserves candidate and aliases after a child dies following its first durable migration",
    { skip: process.platform !== "win32" },
    async () => {
        await verifyWindowsMigrationFailure({
            crash: true,
            expectedEvents: ["stop", "context-committed"],
            expectedAudit: { version: 2, sentinel: "audit" },
            expectedError: /migration 未成功完成/u,
        });
    },
);

test(
    "Windows release installer keeps committed migration when candidate Control restore fails",
    { skip: process.platform !== "win32" },
    async () => {
        await verifyWindowsMigrationFailure({
            crash: false,
            expectedEvents: ["stop", "context-committed", "audit-committed", "candidate-start-failed", "stop"],
            expectedAudit: { version: 3, sentinel: "audit" },
            expectedError: /persistent migration 已提交/u,
        });
    },
);

async function verifyWindowsMigrationFailure({ crash, expectedEvents, expectedAudit, expectedError }) {
    const root = await createTestTempDirectory("windows-release-migration-failure");
    const release = resolve(root, "release");
    const app = resolve(root, "app");
    const installRoot = resolve(root, "installed");
    const binDirectory = resolve(root, "bin");
    const devshellHome = resolve(root, "devshell-home");
    const runtimeLog = resolve(root, "runtime.log");
    const environment = {
        ...externalTerminalEnv(),
        HOME: resolve(root, "home"),
        USERPROFILE: resolve(root, "home"),
        LOCALAPPDATA: resolve(root, "local-app-data"),
        PORTABLE_DEVSHELL_RELEASE_BASE_URL: pathToFileURL(release).href.replace(/\/$/u, ""),
        PORTABLE_DEVSHELL_INSTALL_ROOT: installRoot,
        PORTABLE_DEVSHELL_BIN_DIR: binDirectory,
        PORTABLE_DEVSHELL_HOME: devshellHome,
        PORTABLE_DEVSHELL_TEST_LIVE_HOME: devshellHome,
        PORTABLE_DEVSHELL_TEST_RUNTIME_LOG: runtimeLog,
    };
    let oldControl;
    try {
        await writeTransactionalReleaseFixture({ app, release, version: "9.8.7-old-windows", workerContent: "old-worker\n" });
        const installed = runInstallerRaw(environment, true);
        assert.equal(installed.status, 0, `${installed.stdout}${installed.stderr}`);
        oldControl = await startFakeControl(resolve(installRoot, "current"), devshellHome);
        await writeFile(resolve(devshellHome, "context.json"), JSON.stringify({ version: 1, sentinel: "context" }));
        await writeFile(resolve(devshellHome, "audit.json"), JSON.stringify({ version: 2, sentinel: "audit" }));

        await writeTransactionalReleaseFixture({
            app, release, version: "9.8.8-new-windows", workerContent: "new-worker\n", failRuntimeRestore: true,
        });
        // Simulate independently committed domains, with the child killed after the first.
        const cli = resolve(app, "custom", "devshell-entry.js");
        const original = await readFile(cli, "utf8");
        const migration = [
            "import { openSync, writeFileSync, fsyncSync, closeSync, renameSync } from 'node:fs';",
            "if (process.argv[2] === 'migrate') {",
            "  const home = process.env.PORTABLE_DEVSHELL_HOME;",
            "  const commit = (domain, version) => {",
            "    const pending = `${home}/${domain}.pending`;",
            "    const fd = openSync(pending, 'w');",
            "    writeFileSync(fd, JSON.stringify({ version, sentinel: domain }));",
            "    fsyncSync(fd); closeSync(fd);",
            "    renameSync(pending, `${home}/${domain}.json`);",
            "    appendFileSync(process.env.PORTABLE_DEVSHELL_TEST_RUNTIME_LOG, `${domain}-committed\\n`);",
            "  };",
            "  commit('context', 2);",
            ...(crash ? ["  process.kill(process.pid, 'SIGKILL');"] : []),
            "  commit('audit', 3);",
            "  process.exit(0);",
            "}",
        ].join("\n");
        await writeFile(cli, original.replace("const command =", `${migration}\nconst command =`));
        const manifestPath = resolve(app, "portable-devshell-install.json");
        const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        await writeFile(manifestPath, JSON.stringify({ ...manifest, updatePreflight: true }));
        const control = resolve(app, "node_modules", "@portable-devshell", "control");
        await mkdir(resolve(control, "dist", "migration"), { recursive: true });
        await writeFile(resolve(control, "package.json"), '{"type":"module"}\n');
        await writeFile(resolve(control, "dist", "migration", "Control.js"),
            "export async function preflightControlUpdate() { return { extensions: { checkedGenerations: 0 }, migration: { required: true }, rollback: { feasible: false } }; }\n");
        const archive = resolve(release, applicationAssetName());
        run("tar.exe", ["-czf", archive, "-C", app, "."]);
        await writeChecksum(archive);

        const failed = runInstallerRaw({ ...environment, PORTABLE_DEVSHELL_TEST_RUNNING: "1" }, true);
        assert.equal(failed.error, undefined);
        assert.notEqual(failed.status, 0, `${failed.stdout}${failed.stderr}`);
        assert.match(failed.stderr, expectedError);
        assert.match(failed.stderr, /禁止自动降级/u);
        assert.equal(failed.stdout.includes("Persistent migration 已提交"), !crash);
        assert.doesNotMatch(failed.stdout, /已安装 portable-devshell/u);
        assert.equal(JSON.parse(await readFile(resolve(installRoot, "current", "package.json"), "utf8")).version, "9.8.8-new-windows");
        assert.equal(JSON.parse(await readFile(resolve(installRoot, "versions", "9.8.8-new-windows", "package.json"), "utf8")).version, "9.8.8-new-windows");
        assert.equal(await readFile(resolve(devshellHome, "bin", workerAssetName()), "utf8"), "new-worker\n");
        assert.equal(await readFile(resolve(devshellHome, "bin", "devshell-worker.exe"), "utf8"), "new-worker\n");
        const command = await readFile(resolve(binDirectory, "devshell.cmd"), "utf8");
        assert.ok(command.includes(Buffer.from(resolve(installRoot, "current", "custom", "devshell-entry.js"), "utf8").toString("base64")));
        assert.deepEqual(JSON.parse(await readFile(resolve(devshellHome, "context.json"), "utf8")), { version: 2, sentinel: "context" });
        assert.deepEqual(JSON.parse(await readFile(resolve(devshellHome, "audit.json"), "utf8")), expectedAudit);
        assert.deepEqual((await readFile(runtimeLog, "utf8")).trim().split("\n"), expectedEvents);
        const backups = (await readdir(installRoot)).filter((name) => name.startsWith(".current-backup-"));
        assert.equal(backups.length, 1);
        assert.equal(JSON.parse(await readFile(resolve(installRoot, backups[0], "package.json"), "utf8")).version, "9.8.7-old-windows");
        const workerBackups = (await readdir(devshellHome)).filter((name) => name.startsWith(".install-worker-backup-"));
        assert.equal(workerBackups.length, 1);
        assert.equal(await readFile(resolve(devshellHome, workerBackups[0], "devshell-worker.exe"), "utf8"), "old-worker\n");
        await assert.rejects(lstat(resolve(devshellHome, "control", "control.pid")), { code: "ENOENT" });
    } finally {
        oldControl?.kill("SIGKILL");
        await rm(root, { force: true, recursive: true });
    }
}

test("Windows release installer prepares rollback state before entering Control shutdown", async () => {
    const source = await readFile(
        resolve(repositoryRoot, "scripts", "install-release.ps1"),
        "utf8",
    );
    const prepare = source.indexOf(
        "    Backup-WorkerAliases $targets $devshellHome $workerBackupDirectory",
    );
    const transaction = source.indexOf("    try {", prepare);
    const shutdown = source.indexOf(
        "        Stop-InstalledControl $currentCli $devshellHome",
        transaction,
    );
    assert.ok(prepare >= 0, "Worker activation backup must be present");
    assert.ok(
        transaction > prepare,
        "rollback scope must start after backup preparation",
    );
    assert.ok(
        shutdown > transaction,
        "Control shutdown must execute inside the rollback scope",
    );
});

test("Windows release installer stages all application and Worker copies before shutdown", async () => {
    const source = await readFile(resolve(repositoryRoot, "scripts", "install-release.ps1"), "utf8");
    const preparedApp = source.indexOf("Copy-Item -Recurse -Force -LiteralPath $stagingDirectory -Destination $preparedCurrentDirectory");
    const preparedWorker = source.indexOf("Prepare-Worker $target $temporary $devshellHome");
    const shutdown = source.indexOf("Stop-InstalledControl $currentCli $devshellHome", preparedWorker);
    const activateApp = source.indexOf("Move-Item -LiteralPath $preparedCurrentDirectory -Destination $currentDirectory", shutdown);
    assert.ok(preparedApp >= 0 && preparedWorker > preparedApp);
    assert.ok(shutdown > preparedWorker, "Worker files and prepared application must precede shutdown");
    assert.ok(activateApp > shutdown, "The prepared application is renamed after shutdown");
    assert.doesNotMatch(source.slice(shutdown, activateApp), /Copy-Item -Recurse/u);
});

test("Windows launcher Node payload preserves Unicode path, argv, cwd and exit code", async () => {
    const root = await createTestTempDirectory("windows-launcher-payload");
    try {
        const cli = resolve(root, "入口 空间", "entry.mjs");
        await mkdir(resolve(cli, ".."), { recursive: true });
        await writeFile(
            cli,
            "process.stdout.write(JSON.stringify({ argv: process.argv.slice(1), cwd: process.cwd() })); process.exit(17);\n",
        );
        const source = await readFile(
            resolve(repositoryRoot, "scripts", "install-release.ps1"),
            "utf8",
        );
        const template = source.match(/\$launcher = "([^"\r\n]+)"/u)?.[1];
        assert.ok(template, "exercise the actual installer payload");
        const payload = template.replace(
            "$encodedCliPath",
            Buffer.from(cli, "utf8").toString("base64"),
        );
        const outputPath = resolve(root, "output.json");
        const output = await open(outputPath, "w");
        try {
            const result = spawnSync(
                process.execPath,
                ["-e", payload, "--", "two words", "中文参数", "--flag"],
                { cwd: root, stdio: ["ignore", output.fd, "inherit"], timeout: 15_000 },
            );
            assert.equal(result.error, undefined);
            assert.equal(result.status, 17);
        } finally {
            await output.close();
        }
        assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), {
            argv: [cli, "two words", "中文参数", "--flag"],
            cwd: root,
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

// Real installer runs use only fixture releases and paths under a test-owned root.
// The writer stays alive (and ignores TERM) until cleanup kills and reaps it.
for (const shell of ["sh", "bash"]) {
    for (const scenario of [
        "early-TERM",
        "partial-TERM",
        "partial-HUP",
        "partial-INT",
        "failure",
        "success",
        "launch-gap",
    ]) {
        test(
            `Unix migration rollback ordering: ${shell} ${scenario}`,
            {
                skip: process.platform === "win32",
                timeout: 30_000,
            },
            async () => {
                await verifyUnixMigrationInterruption(shell, scenario);
            },
        );
    }
}

async function verifyUnixMigrationInterruption(shell, scenario) {
    const root = await createTestTempDirectory(
        "release-migration-interruption",
    );
    const app = resolve(root, "app");
    const release = resolve(root, "release");
    const installRoot = resolve(root, "installed");
    const devshellHome = resolve(root, "state");
    const extensionData = resolve(
        root,
        "data",
        "portable-devshell",
        "extension-data",
    );
    const runtimeLog = resolve(root, "runtime.log");
    const writerPidFile = resolve(root, "writer.pid");
    const readyFile = resolve(root, "writer.ready");
    const oldVersion = "9.8.7-migration-old";
    const newVersion = "9.8.8-migration-new";
    const environment = {
        ...externalTerminalEnv(),
        HOME: resolve(root, "home"),
        USERPROFILE: resolve(root, "home"),
        XDG_DATA_HOME: resolve(root, "data"),
        XDG_RUNTIME_DIR: resolve(root, "runtime"),
        TMPDIR: resolve(root, "tmp"),
        PORTABLE_DEVSHELL_HOME: devshellHome,
        PORTABLE_DEVSHELL_INSTALL_ROOT: installRoot,
        PORTABLE_DEVSHELL_BIN_DIR: resolve(root, "bin"),
        PORTABLE_DEVSHELL_RELEASE_BASE_URL: pathToFileURL(release).href.replace(
            /\/$/u,
            "",
        ),
        PORTABLE_DEVSHELL_TEST_LIVE_HOME: devshellHome,
        PORTABLE_DEVSHELL_TEST_RUNTIME_LOG: runtimeLog,
        PORTABLE_DEVSHELL_TEST_WRITER_PID: writerPidFile,
        PORTABLE_DEVSHELL_TEST_READY: readyFile,
        PORTABLE_DEVSHELL_TEST_EXTENSION_DATA: extensionData,
        PORTABLE_DEVSHELL_TEST_SCENARIO: scenario,
    };
    let oldControl;
    let installer;
    let writerPid;
    try {
        for (const name of [
            environment.HOME,
            environment.TMPDIR,
            environment.XDG_RUNTIME_DIR,
        ]) {
            await mkdir(name, { recursive: true });
        }
        await writeTransactionalReleaseFixture({
            app,
            release,
            version: oldVersion,
            workerContent: "old-worker\n",
        });
        const oldCli = resolve(app, "custom", "devshell-entry.js");
        const oldSource = await readFile(oldCli, "utf8");
        await writeFile(
            oldCli,
            oldSource.replace(
                "const command =",
                [
                    "if (process.argv[2] === 'start') {",
                    "  const pidFile = process.env.PORTABLE_DEVSHELL_TEST_WRITER_PID;",
                    "  const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : undefined;",
                    "  let alive = false; if (pid) { try { process.kill(pid, 0); alive = true; } catch {} }",
                    "  const state = readFileSync(`${process.env.PORTABLE_DEVSHELL_HOME}/config.json`, 'utf8');",
                    "  const extension = readFileSync(`${process.env.PORTABLE_DEVSHELL_TEST_EXTENSION_DATA}/host.json`, 'utf8');",
                    "  appendFileSync(process.env.PORTABLE_DEVSHELL_TEST_RUNTIME_LOG, `old-start:${alive ? 'writer-alive' : 'writer-dead'}:${state}:${extension}\\n`);",
                    "  if (alive || state !== 'old-config' || extension !== 'old-host') process.exit(99);",
                    "}",
                    "const command =",
                ].join("\n"),
            ),
        );
        await packFixture(app, release);
        const installed = runInstallerRaw(environment, false);
        assert.equal(
            installed.status,
            0,
            `${installed.stdout}${installed.stderr}`,
        );
        await writeFile(resolve(devshellHome, "config.json"), "old-config");
        await writeFile(resolve(devshellHome, "audit.json"), "old-audit");
        await mkdir(extensionData, { recursive: true });
        await writeFile(resolve(extensionData, "host.json"), "old-host");
        oldControl = await startFakeControl(
            resolve(installRoot, "versions", oldVersion),
            devshellHome,
        );
        await writeTransactionalReleaseFixture({
            app,
            release,
            version: newVersion,
            workerContent: "new-worker\n",
        });
        const candidateCli = resolve(app, "custom", "devshell-entry.js");
        const candidateSource = await readFile(candidateCli, "utf8");
        await writeFile(
            candidateCli,
            candidateSource.replace(
                "const command =",
                [
                    "import { writeFileSync, openSync, fsyncSync, closeSync, renameSync } from 'node:fs';",
                    "if (process.argv[2] === 'migrate') {",
                    "  const scenario = process.env.PORTABLE_DEVSHELL_TEST_SCENARIO;",
                    "  writeFileSync(process.env.PORTABLE_DEVSHELL_TEST_WRITER_PID, String(process.pid));",
                    "  const commit = (path, value) => { const pending = `${path}.pending`; const fd = openSync(pending, 'w'); writeFileSync(fd, value); fsyncSync(fd); closeSync(fd); renameSync(pending, path); };",
                    "  const write = () => {",
                    "    commit(`${process.env.PORTABLE_DEVSHELL_HOME}/config.json`, 'new-config');",
                    "    commit(`${process.env.PORTABLE_DEVSHELL_TEST_EXTENSION_DATA}/host.json`, 'new-host');",
                    "    commit(`${process.env.PORTABLE_DEVSHELL_HOME}/new-domain.json`, 'new-domain');",
                    "  };",
                    "  process.on('SIGTERM', () => {});",
                    "  if (scenario !== 'early-TERM') write();",
                    "  appendFileSync(process.env.PORTABLE_DEVSHELL_TEST_RUNTIME_LOG, 'migration-ready\\n');",
                    "  writeFileSync(process.env.PORTABLE_DEVSHELL_TEST_READY, 'ready');",
                    "  if (scenario === 'success') { commit(`${process.env.PORTABLE_DEVSHELL_HOME}/audit.json`, 'new-audit'); process.exit(0); }",
                    "  if (scenario === 'failure') process.exit(23);",
                    "  setInterval(scenario === 'early-TERM' ? () => {} : write, 10);",
                    "  await new Promise(() => {});",
                    "}",
                    "const command =",
                ].join("\n"),
            ),
        );
        const manifestPath = resolve(app, "portable-devshell-install.json");
        const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        await writeFile(
            manifestPath,
            JSON.stringify({ ...manifest, updatePreflight: true }),
        );
        const control = resolve(
            app,
            "node_modules",
            "@portable-devshell",
            "control",
        );
        await mkdir(resolve(control, "dist", "migration"), { recursive: true });
        await writeFile(
            resolve(control, "package.json"),
            '{"type":"module"}\n',
        );
        await writeFile(
            resolve(control, "dist", "migration", "Control.js"),
            "export async function preflightControlUpdate() { return { extensions: { checkedGenerations: 0 }, migration: { required: true }, rollback: { feasible: true } }; }\n",
        );
        await packFixture(app, release);
        let script = resolve(repositoryRoot, "scripts", "install-release.sh");
        if (scenario === "launch-gap") {
            script = resolve(root, "installer-launch-gap.sh");
            const source = await readFile(
                resolve(repositoryRoot, "scripts", "install-release.sh"),
                "utf8",
            );
            // Stop at the exact async-launch/PID-capture boundary. Do not add
            // production fault hooks; run a private copy of the installer.
            await writeFile(
                script,
                source.replace(
                    "    migration_pid=$!",
                    () => [
                        '    while [ ! -f "$PORTABLE_DEVSHELL_TEST_READY" ]; do sleep 0.01; done',
                        "    kill -TERM $$",
                        "    migration_pid=$!",
                    ].join("\n"),
                ),
            );
        }
        installer = spawn(shell, [script], {
            cwd: root,
            env: { ...environment, PORTABLE_DEVSHELL_TEST_RUNNING: "1" },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        installer.stdout.on("data", (data) => {
            stdout += data;
        });
        installer.stderr.on("data", (data) => {
            stderr += data;
        });
        // An intentionally retained writer inherits the pipes in launch-gap;
        // await the installer exit, not pipe closure.
        const exited = new Promise((resolveExit, reject) => {
            installer.once("error", reject);
            installer.once("exit", (code, signal) =>
                resolveExit({ code, signal }),
            );
        });
        await waitForFixtureFile(readyFile);
        writerPid = Number(await readFile(writerPidFile, "utf8"));
        if (scenario !== "success" && scenario !== "failure") {
            assert.equal(
                await readFile(resolve(devshellHome, "config.json"), "utf8"),
                scenario === "early-TERM" ? "old-config" : "new-config",
            );
            assert.equal(await readFile(resolve(devshellHome, "audit.json"), "utf8"), "old-audit");
        }
        if (
            scenario.includes("-TERM") ||
            scenario === "partial-HUP" ||
            scenario === "partial-INT"
        ) {
            installer.kill(`SIG${scenario.split("-")[1]}`);
        }
        const result = await Promise.race([
            exited,
            new Promise((_, reject) => {
                const timer = setTimeout(
                    () =>
                        reject(
                            new Error(`installer timeout\n${stdout}${stderr}`),
                        ),
                    15_000,
                );
                timer.unref();
            }),
        ]);
        assert.equal(result.signal, null, `${stdout}${stderr}`);
        assert.equal(
            result.code,
            scenario === "success"
                ? 0
                : scenario === "launch-gap"
                  ? 1
                  : scenario === "failure"
                    ? 1
                    : { TERM: 143, HUP: 129, INT: 130 }[scenario.split("-")[1]],
            `${stdout}${stderr}`,
        );
        const version = JSON.parse(
            await readFile(
                resolve(installRoot, "current", "package.json"),
                "utf8",
            ),
        ).version;
        const events = (await readFile(runtimeLog, "utf8")).trim().split("\n");
        const snapshots = (await readdir(installRoot)).filter((name) =>
            name.startsWith(".persistent-backup-"),
        );
        if (scenario === "launch-gap") {
            assert.equal(version, newVersion);
            assert.equal(snapshots.length, 1);
            assert.equal(
                await readFile(
                    resolve(
                        installRoot,
                        snapshots[0],
                        "devshell",
                        "config.json",
                    ),
                    "utf8",
                ),
                "old-config",
            );
            assert.deepEqual(events, ["stop", "migration-ready"]);
            assert.match(stderr, /PID 尚未确认/u);
            assert.equal(process.kill(writerPid, 0), true);
        } else {
            assert.equal(
                version,
                scenario === "success" ? newVersion : oldVersion,
            );
            assert.equal(
                snapshots.length,
                0,
                "success and completed rollback must remove snapshots",
            );
            assert.equal(
                await readFile(resolve(devshellHome, "config.json"), "utf8"),
                scenario === "success" ? "new-config" : "old-config",
            );
            assert.equal(
                await readFile(resolve(extensionData, "host.json"), "utf8"),
                scenario === "success" ? "new-host" : "old-host",
            );
            assert.equal(
                await readFile(resolve(devshellHome, "audit.json"), "utf8"),
                scenario === "success" ? "new-audit" : "old-audit",
            );
            assert.equal(
                await readFile(
                    resolve(devshellHome, "bin", workerAssetName()),
                    "utf8",
                ),
                scenario === "success" ? "new-worker\n" : "old-worker\n",
            );
            if (scenario !== "success") {
                await assert.rejects(
                    lstat(resolve(devshellHome, "new-domain.json")),
                    { code: "ENOENT" },
                );
                assert.equal(
                    events[2],
                    "old-start:writer-dead:old-config:old-host",
                );
                assert.deepEqual(events.slice(3), [
                    "start",
                    "instance:ready-local",
                    "instance:starting-ssh",
                    "instance:stale-local",
                ]);
                assert.throws(() => process.kill(writerPid, 0), {
                    code: "ESRCH",
                });
            }
        }
    } finally {
        if (installer?.exitCode === null) installer.kill("SIGKILL");
        if (!writerPid) {
            try {
                writerPid = Number(await readFile(writerPidFile, "utf8"));
            } catch { /* The fixture may already have exited. */ }
        }
        if (writerPid) {
            try {
                process.kill(writerPid, "SIGKILL");
            } catch { /* The fixture may already have exited. */ }
        }
        oldControl?.kill("SIGKILL");
        await rm(root, { recursive: true, force: true });
    }
}

async function packFixture(app, release) {
    const archive = resolve(release, applicationAssetName());
    run(process.platform === "win32" ? "tar.exe" : "tar", [
        "-czf",
        archive,
        "-C",
        app,
        ".",
    ]);
    await writeChecksum(archive);
}

async function waitForFixtureFile(path) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        try {
            await readFile(path);
            return;
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    throw new Error(`fixture did not become ready: ${path}`);
}

async function verifyTransactionalRollback(windows, previousCommandBytes) {
    const root = await createTestTempDirectory(
        windows ? "windows-release-rollback-test" : "release-rollback-test",
    );
    const release = resolve(root, "release");
    const app = resolve(root, "app");
    const home = resolve(root, windows ? "用户 空间" : "home");
    const installRoot = resolve(root, windows ? "安装 目录" : "installed");
    const binDirectory = windows ? resolve(home, "命令 目录") : resolve(root, "bin");
    const devshellHome = resolve(root, "devshell-home");
    const environment = {
        ...externalTerminalEnv(),
        HOME: home,
        XDG_DATA_HOME: resolve(root, "data"),
        PORTABLE_DEVSHELL_RELEASE_BASE_URL: pathToFileURL(release).href.replace(
            /\/$/u,
            "",
        ),
        PORTABLE_DEVSHELL_INSTALL_ROOT: installRoot,
        PORTABLE_DEVSHELL_BIN_DIR: binDirectory,
        PORTABLE_DEVSHELL_HOME: devshellHome,
        ...(windows
            ? {
                  USERPROFILE: home,
                  LOCALAPPDATA: resolve(root, "local-app-data"),
              }
            : {}),
    };
    const oldVersion = windows ? "9.8.7-old-windows" : "9.8.7-old";
    const brokenVersion = windows
        ? "9.8.8-broken-after-activation-windows"
        : "9.8.8-broken-after-activation";

    try {
        await writeTransactionalReleaseFixture({
            app,
            release,
            version: oldVersion,
            workerContent: "old-worker\n",
        });
        const installed = runInstallerRaw(environment, windows);
        assert.equal(
            installed.status,
            0,
            `${installed.stdout}${installed.stderr}`,
        );

        const commandPath = resolve(binDirectory, windows ? "devshell.cmd" : "devshell");
        if (previousCommandBytes !== undefined) await writeFile(commandPath, previousCommandBytes);
        const commandBefore = await readFile(commandPath);

        const workerAlias = resolve(devshellHome, "bin", workerAssetName());
        const defaultAlias = resolve(
            devshellHome,
            "bin",
            windows ? "devshell-worker.exe" : "devshell-worker",
        );
        assert.equal(await readFile(workerAlias, "utf8"), "old-worker\n");
        assert.equal(await readFile(defaultAlias, "utf8"), "old-worker\n");

        await writeTransactionalReleaseFixture({
            app,
            failAfterActivation: true,
            release,
            version: brokenVersion,
            workerContent: "new-worker\n",
        });
        const failed = runInstallerRaw(environment, windows);
        assert.notEqual(failed.status, 0, `${failed.stdout}${failed.stderr}`);

        const restored = JSON.parse(
            await readFile(
                resolve(installRoot, "current", "package.json"),
                "utf8",
            ),
        );
        assert.equal(restored.version, oldVersion);
        assert.deepEqual(await readFile(commandPath), commandBefore);
        assert.equal(await readFile(workerAlias, "utf8"), "old-worker\n");
        assert.equal(await readFile(defaultAlias, "utf8"), "old-worker\n");
    } finally {
        await rm(root, { force: true, recursive: true });
    }
}

async function writeTransactionalReleaseFixture({
    app,
    failAfterActivation = false,
    failInstanceRestore = false,
    failRuntimeRestore = false,
    release,
    version,
    workerContent,
}) {
    await rm(app, { force: true, recursive: true });
    await mkdir(resolve(app, "custom"), { recursive: true });
    await mkdir(release, { recursive: true });
    await writeFile(
        resolve(app, "package.json"),
        `${JSON.stringify(
            {
                name: "portable-devshell",
                version,
                private: true,
                type: "module",
                bin: { devshell: "./custom/devshell-entry.js" },
                engines: { node: ">=24" },
            },
            null,
            2,
        )}\n`,
        "utf8",
    );
    await writeFile(
        resolve(app, "portable-devshell-install.json"),
        `${JSON.stringify(
            {
                minimumNodeMajor: 24,
                version,
            },
            null,
            2,
        )}\n`,
        "utf8",
    );
    const cli = resolve(app, "custom", "devshell-entry.js");
    await writeFile(
        cli,
        [
            "#!/usr/bin/env node",
            "import { appendFileSync, existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';",
            "const command = process.argv[2] ?? 'status';",
            "const staged = realpathSync(process.argv[1]).includes('.staging-');",
            "const liveHome = process.env.PORTABLE_DEVSHELL_TEST_LIVE_HOME || '';",
            "const running = process.env.PORTABLE_DEVSHELL_TEST_RUNNING === '1' && !staged && process.env.PORTABLE_DEVSHELL_HOME === liveHome;",
            "const runtimeLog = process.env.PORTABLE_DEVSHELL_TEST_RUNTIME_LOG || '';",
            "const pidFile = `${process.env.PORTABLE_DEVSHELL_HOME || ''}/control/control.pid`;",
            "const controlPid = running && existsSync(pidFile) ? Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10) : undefined;",
            "const record = (line) => { if (runtimeLog) appendFileSync(runtimeLog, `${line}\\n`); };",
            ...(failAfterActivation
                ? [
                      "if (command === 'status' && !staged) { process.stderr.write('post-activation failure\\n'); process.exit(1); }",
                  ]
                : []),
            "if (command === 'status') process.stdout.write(running ? `control: running\\npid: ${controlPid}\\n` : 'control: stopped\\n');",
            "else if (command === 'overview' && running) process.stdout.write(JSON.stringify({ instances: [",
            "  { name: 'ready-local', snapshot: { daemonState: 'running' } },",
            "  { name: 'starting-ssh', snapshot: { daemonState: 'starting' } },",
            "  { name: 'stale-local', snapshot: { daemonState: 'stale' } },",
            "  { name: 'stopped-local', snapshot: { daemonState: 'stopped' } },",
            "  { name: 'reverse-node', snapshot: { daemonState: 'running', reverse: { connected: true } } }",
            "] }));",
            "else if (command === 'stop') { if (controlPid) process.kill(controlPid, 'SIGTERM'); rmSync(pidFile, { force: true }); record('stop'); }",
            ...(failRuntimeRestore
                ? [
                      "else if (command === 'start') { record('candidate-start-failed'); process.stderr.write('real-state start failure\\n'); process.exit(1); }",
                  ]
                : ["else if (command === 'start') record('start');"]),
            ...(failInstanceRestore
                ? [
                      "else if (command === 'instance' && process.argv[3] === 'start') { record(`instance:${process.argv[4]}`); if (process.argv[4] === 'ready-local') { if (process.env.PORTABLE_DEVSHELL_TEST_LIVE_HOME) appendFileSync(`${process.env.PORTABLE_DEVSHELL_TEST_LIVE_HOME}/data-before-upgrade.txt`, 'candidate-write\\n'); process.stderr.write('instance restore failure\\n'); process.exit(1); } }",
                  ]
                : [
                      "else if (command === 'instance' && process.argv[3] === 'start') record(`instance:${process.argv[4]}`);",
                  ]),
            "else { process.stderr.write(`unsupported test command: ${command}\\n`); process.exit(2); }",
            "",
        ].join("\n"),
        "utf8",
    );
    if (process.platform !== "win32") await chmod(cli, 0o755);

    const archive = resolve(release, applicationAssetName());
    run(process.platform === "win32" ? "tar.exe" : "tar", [
        "-czf",
        archive,
        "-C",
        app,
        ".",
    ]);
    await writeChecksum(archive);
    const worker = resolve(release, workerAssetName());
    await writeFile(worker, workerContent, "utf8");
    await writeChecksum(worker);
}

async function startFakeControl(applicationDirectory, devshellHome) {
    const daemon = resolve(
        applicationDirectory,
        "node_modules",
        "@portable-devshell",
        "control",
        "dist",
        "server",
        "Daemon.js",
    );
    await mkdir(resolve(daemon, ".."), { recursive: true });
    await mkdir(resolve(devshellHome, "control"), { recursive: true });
    await writeFile(daemon, "setInterval(() => {}, 1000);\n", "utf8");
    const child = spawn(process.execPath, [daemon], { stdio: "ignore" });
    await writeFile(
        resolve(devshellHome, "control", "control.pid"),
        `${child.pid}\n`,
        "utf8",
    );
    return child;
}

function runInstallerRaw(environment, windows) {
    const executable = windows ? "powershell.exe" : "sh";
    const args = windows
        ? [
              "-NoProfile",
              "-NonInteractive",
              "-ExecutionPolicy",
              "Bypass",
              "-File",
              resolve(repositoryRoot, "scripts", "install-release.ps1"),
          ]
        : [resolve(repositoryRoot, "scripts", "install-release.sh")];
    return spawnSync(executable, args, {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: environment,
        timeout: 30_000,
    });
}

function workerAssetName() {
    const target = hostTarget();
    return target.startsWith("windows-")
        ? `devshell-worker-${target}.exe`
        : `devshell-worker-${target}`;
}
