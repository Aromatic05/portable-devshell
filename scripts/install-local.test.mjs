import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { delimiter, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createTestTempDirectory } from "../test/TestTempDirectory.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const CURRENT_DEVELOPMENT_VERSION = "0.6.17"; // version-state:current-development

 test("install-local rejects stale activation before stopping or changing active Worker aliases", {
    skip: process.platform === "win32",
}, async () => {
    const root = await createTestTempDirectory("install-local-stale-activation-test");
    const home = resolve(root, "home");
    const installRoot = resolve(root, "installed");
    const binDirectory = resolve(root, "bin");
    const devshellHome = resolve(root, "devshell-home");
    const fakeBin = resolve(root, "fake-bin");
    const stopLog = resolve(root, "stop.log");
    const activatedVersionDirectory = resolve(installRoot, "versions", "9.8.7-activated");
    const runningVersionDirectory = resolve(installRoot, "versions", "9.8.9-actually-running");
    const currentLink = resolve(installRoot, "current");
    const workerBinDirectory = resolve(devshellHome, "bin");
    const hostTarget = resolveHostTarget();
    const workerAsset = `devshell-worker-${hostTarget}`;
    const workerBytes = Buffer.from("candidate-worker\n", "utf8");
    const workerSha = createHash("sha256").update(workerBytes).digest("hex");
    let liveControl;
    let server;

    try {
        await mkdir(resolve(activatedVersionDirectory, "custom"), { recursive: true });
        await mkdir(resolve(runningVersionDirectory, "test-runtime"), { recursive: true });
        await mkdir(resolve(devshellHome, "control"), { recursive: true });
        await mkdir(workerBinDirectory, { recursive: true });
        await mkdir(fakeBin, { recursive: true });
        await mkdir(home, { recursive: true });

        await writeFile(resolve(activatedVersionDirectory, "package.json"), `${JSON.stringify({
            name: "portable-devshell",
            version: "9.8.7-activated",
            type: "module",
            bin: { devshell: "./custom/devshell-entry.js" },
        })}\n`, "utf8");
        const oldCli = resolve(activatedVersionDirectory, "custom", "devshell-entry.js");
        await writeFile(oldCli, [
            "#!/usr/bin/env node",
            "import { appendFileSync, readFileSync } from 'node:fs';",
            `const pidFile = ${JSON.stringify(resolve(devshellHome, "control", "control.pid"))};`,
            `const stopLog = ${JSON.stringify(stopLog)};`,
            "const pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10);",
            "const command = process.argv[2] ?? 'status';",
            "if (command === 'status') process.stdout.write(`control: running\\npid: ${pid}\\ninstances: 0\\n`);",
            "else if (command === 'overview') process.stdout.write(JSON.stringify({ instances: [] }));",
            "else if (command === 'stop') appendFileSync(stopLog, 'stop\\n');",
            "else process.exit(2);",
            "",
        ].join("\n"), "utf8");
        await chmod(oldCli, 0o755);
        await symlink("versions/9.8.7-activated", currentLink);

        const daemon = resolve(runningVersionDirectory, "test-runtime", "ControlDaemon.js");
        await writeFile(daemon, "setInterval(() => {}, 1000);\n", "utf8");
        liveControl = spawn(process.execPath, [daemon], { stdio: "ignore" });
        await writeFile(resolve(devshellHome, "control", "control.pid"), `${liveControl.pid}\n`, "utf8");

        await writeFile(resolve(workerBinDirectory, workerAsset), "old-worker\n", "utf8");
        await symlink(workerAsset, resolve(workerBinDirectory, "devshell-worker"));

        const fakePnpm = resolve(fakeBin, "pnpm");
        await writeFile(fakePnpm, [
            "#!/usr/bin/env node",
            "import { mkdirSync, writeFileSync } from 'node:fs';",
            "import { resolve } from 'node:path';",
            "const args = process.argv.slice(2);",
            "const deploy = args.indexOf('deploy');",
            "if (deploy >= 0) {",
            "  const out = resolve(args[deploy + 1]);",
            "  mkdirSync(resolve(out, 'dist'), { recursive: true });",
            "  writeFileSync(resolve(out, 'package.json'), JSON.stringify({ name: '@portable-devshell/cli', version: '0.0.0', type: 'module', bin: { devshell: './dist/CliMain.js' } }));",
            "  writeFileSync(resolve(out, 'dist', 'CliMain.js'), `#!/usr/bin/env node\\nif ((process.argv[2] ?? 'status') === 'status') process.stdout.write('control: stopped\\\\n'); else process.exit(2);\\n`);",
            "}",
            "",
        ].join("\n"), "utf8");
        await chmod(fakePnpm, 0o755);

        server = createServer((request, response) => {
            if (request.url?.endsWith(`/${workerAsset}.sha256`)) {
                response.end(`${workerSha}  ${workerAsset}\n`);
                return;
            }
            if (request.url?.endsWith(`/${workerAsset}`)) {
                response.end(workerBytes);
                return;
            }
            response.statusCode = 404;
            response.end("missing");
        });
        await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
        const address = server.address();
        assert.ok(typeof address === "object" && address !== null);

        const result = await runProcess(process.execPath, [resolve(repositoryRoot, "scripts", "install-local.mjs")], {
            ...process.env,
            HOME: home,
            PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
            PORTABLE_DEVSHELL_BIN_DIR: binDirectory,
            PORTABLE_DEVSHELL_HOME: devshellHome,
            PORTABLE_DEVSHELL_INSTALL_ROOT: installRoot,
            PORTABLE_DEVSHELL_WORKER_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}`,
            XDG_DATA_HOME: resolve(root, "data"),
        });

        assert.notEqual(result.code, 0, `${result.stdout}${result.stderr}`);
        assert.match(result.stderr, /does not belong to the activated application generation/iu);
        assert.equal(await readFile(stopLog, "utf8").catch(() => ""), "");
        assert.equal(await readFile(resolve(workerBinDirectory, workerAsset), "utf8"), "old-worker\n");
        assert.equal(await readlink(resolve(workerBinDirectory, "devshell-worker")), workerAsset);
        assert.equal(await readlink(currentLink), "versions/9.8.7-activated");
        assert.doesNotThrow(() => process.kill(liveControl.pid, 0));
    } finally {
        liveControl?.kill("SIGKILL");
        await new Promise((resolveClose) => server?.close(() => resolveClose()));
        await rm(root, { force: true, recursive: true });
    }
});

function resolveHostTarget() {
    const os = process.platform === "linux" ? "linux" : process.platform === "darwin" ? "darwin" : undefined;
    const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : undefined;
    if (os === undefined || arch === undefined) throw new Error(`unsupported test host ${process.platform}/${process.arch}`);
    return `${os}-${arch}`;
}

async function runProcess(command, args, env) {
    const child = spawn(command, args, { cwd: repositoryRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const code = await new Promise((resolveExit, reject) => {
        child.once("error", reject);
        child.once("exit", (value) => resolveExit(value ?? 1));
    });
    return { code, stderr, stdout };
}

test("install-local rolls back application and Worker activation before restoring the exact previous runtime", {
    skip: process.platform === "win32",
}, async () => {
    const root = await createTestTempDirectory("install-local-rollback-test");
    const home = resolve(root, "home");
    const installRoot = resolve(root, "installed");
    const binDirectory = resolve(root, "bin");
    const devshellHome = resolve(root, "devshell-home");
    const fakeBin = resolve(root, "fake-bin");
    const runtimeLog = resolve(root, "runtime.log");
    const activatedVersionDirectory = resolve(installRoot, "versions", "9.8.7-running");
    const currentLink = resolve(installRoot, "current");
    const workerBinDirectory = resolve(devshellHome, "bin");
    const hostTarget = resolveHostTarget();
    const workerAsset = `devshell-worker-${hostTarget}`;
    const workerBytes = Buffer.from("candidate-worker\n", "utf8");
    const workerSha = createHash("sha256").update(workerBytes).digest("hex");
    let liveControl;
    let server;

    try {
        await mkdir(resolve(activatedVersionDirectory, "custom"), { recursive: true });
        await mkdir(resolve(activatedVersionDirectory, "test-runtime"), { recursive: true });
        await mkdir(resolve(devshellHome, "control"), { recursive: true });
        await mkdir(workerBinDirectory, { recursive: true });
        await mkdir(fakeBin, { recursive: true });
        await mkdir(home, { recursive: true });

        await writeFile(resolve(activatedVersionDirectory, "package.json"), `${JSON.stringify({
            name: "portable-devshell",
            version: "9.8.7-running",
            type: "module",
            bin: { devshell: "./custom/devshell-entry.js" },
        })}\n`, "utf8");
        const oldCli = resolve(activatedVersionDirectory, "custom", "devshell-entry.js");
        await writeFile(oldCli, [
            "#!/usr/bin/env node",
            "import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';",
            `const pidFile = ${JSON.stringify(resolve(devshellHome, "control", "control.pid"))};`,
            `const runtimeLog = ${JSON.stringify(runtimeLog)};`,
            "const command = process.argv[2] ?? 'status';",
            "const pid = existsSync(pidFile) ? Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10) : undefined;",
            "if (command === 'status') process.stdout.write(pid ? `control: running\\npid: ${pid}\\ninstances: 0\\n` : 'control: stopped\\n');",
            "else if (command === 'overview') process.stdout.write(JSON.stringify({ instances: [] }));",
            "else if (command === 'stop') { if (pid) process.kill(pid, 'SIGTERM'); rmSync(pidFile, { force: true }); appendFileSync(runtimeLog, 'stop\\n'); }",
            "else if (command === 'start') appendFileSync(runtimeLog, 'start\\n');",
            "else if (command === 'instance' && process.argv[3] === 'start') appendFileSync(runtimeLog, `instance:${process.argv[4]}\\n`);",
            "else process.exit(2);",
            "",
        ].join("\n"), "utf8");
        await chmod(oldCli, 0o755);
        await symlink("versions/9.8.7-running", currentLink);

        const daemon = resolve(activatedVersionDirectory, "test-runtime", "ControlDaemon.js");
        await writeFile(daemon, "setInterval(() => {}, 1000);\n", "utf8");
        liveControl = spawn(process.execPath, [daemon], { stdio: "ignore" });
        await writeFile(resolve(devshellHome, "control", "control.pid"), `${liveControl.pid}\n`, "utf8");

        await writeFile(resolve(workerBinDirectory, workerAsset), "old-worker\n", "utf8");
        await symlink(workerAsset, resolve(workerBinDirectory, "devshell-worker"));

        const fakePnpm = resolve(fakeBin, "pnpm");
        await writeFile(fakePnpm, [
            "#!/usr/bin/env node",
            "import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';",
            "import { resolve } from 'node:path';",
            "const args = process.argv.slice(2);",
            "const deploy = args.indexOf('deploy');",
            "if (deploy >= 0) {",
            "  const out = resolve(args[deploy + 1]);",
            "  mkdirSync(resolve(out, 'dist'), { recursive: true });",
            "  writeFileSync(resolve(out, 'package.json'), JSON.stringify({ name: '@portable-devshell/cli', version: '0.0.0', type: 'module', bin: { devshell: './dist/CliMain.js' } }));",
            "  writeFileSync(resolve(out, 'dist', 'CliMain.js'), `#!/usr/bin/env node\\nimport { realpathSync } from 'node:fs';\\nconst staged = realpathSync(process.argv[1]).includes('.staging-');\\nif ((process.argv[2] ?? 'status') === 'status' && staged) process.stdout.write('control: stopped\\\\n'); else { process.stderr.write('post-activation failure\\\\n'); process.exit(1); }\\n`);",
            "}",
            "",
        ].join("\n"), "utf8");
        await chmod(fakePnpm, 0o755);

        server = createServer((request, response) => {
            if (request.url?.endsWith(`/${workerAsset}.sha256`)) {
                response.end(`${workerSha}  ${workerAsset}\n`);
                return;
            }
            if (request.url?.endsWith(`/${workerAsset}`)) {
                response.end(workerBytes);
                return;
            }
            response.statusCode = 404;
            response.end("missing");
        });
        await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
        const address = server.address();
        assert.ok(typeof address === "object" && address !== null);

        const result = await runProcess(process.execPath, [resolve(repositoryRoot, "scripts", "install-local.mjs")], {
            ...process.env,
            HOME: home,
            PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
            PORTABLE_DEVSHELL_BIN_DIR: binDirectory,
            PORTABLE_DEVSHELL_HOME: devshellHome,
            PORTABLE_DEVSHELL_INSTALL_ROOT: installRoot,
            PORTABLE_DEVSHELL_WORKER_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}`,
            XDG_DATA_HOME: resolve(root, "data"),
        });

        assert.notEqual(result.code, 0, `${result.stdout}${result.stderr}`);
        assert.match(result.stderr, /post-activation failure/iu);
        assert.equal(await readlink(currentLink), "versions/9.8.7-running");
        assert.equal(await readFile(resolve(workerBinDirectory, workerAsset), "utf8"), "old-worker\n");
        assert.equal(await readlink(resolve(workerBinDirectory, "devshell-worker")), workerAsset);
        assert.deepEqual((await readFile(runtimeLog, "utf8")).trim().split("\n"), ["stop", "start"]);
    } finally {
        liveControl?.kill("SIGKILL");
        await new Promise((resolveClose) => server?.close(() => resolveClose()));
        await rm(root, { force: true, recursive: true });
    }
});

test("install-local completes Worker activation backup before stopping the previous runtime", {
    skip: process.platform === "win32",
}, async () => {
    const root = await createTestTempDirectory("install-local-pretransaction-rollback-test");
    const home = resolve(root, "home");
    const installRoot = resolve(root, "installed");
    const binDirectory = resolve(root, "bin");
    const devshellHome = resolve(root, "devshell-home");
    const fakeBin = resolve(root, "fake-bin");
    const runtimeLog = resolve(root, "runtime.log");
    const activatedVersionDirectory = resolve(installRoot, "versions", "9.8.7-running");
    const currentLink = resolve(installRoot, "current");
    const workerBinDirectory = resolve(devshellHome, "bin");
    const hostTarget = resolveHostTarget();
    const workerAsset = `devshell-worker-${hostTarget}`;
    const workerBytes = Buffer.from("candidate-worker\n", "utf8");
    const workerSha = createHash("sha256").update(workerBytes).digest("hex");
    let liveControl;
    let server;

    try {
        await mkdir(resolve(activatedVersionDirectory, "custom"), { recursive: true });
        await mkdir(resolve(activatedVersionDirectory, "test-runtime"), { recursive: true });
        await mkdir(resolve(devshellHome, "control"), { recursive: true });
        await mkdir(workerBinDirectory, { recursive: true });
        await mkdir(fakeBin, { recursive: true });
        await mkdir(home, { recursive: true });

        await writeFile(resolve(activatedVersionDirectory, "package.json"), `${JSON.stringify({
            name: "portable-devshell",
            version: "9.8.7-running",
            type: "module",
            bin: { devshell: "./custom/devshell-entry.js" },
        })}\n`, "utf8");
        const oldCli = resolve(activatedVersionDirectory, "custom", "devshell-entry.js");
        await writeFile(oldCli, [
            "#!/usr/bin/env node",
            "import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';",
            `const pidFile = ${JSON.stringify(resolve(devshellHome, "control", "control.pid"))};`,
            `const runtimeLog = ${JSON.stringify(runtimeLog)};`,
            "const command = process.argv[2] ?? 'status';",
            "const pid = existsSync(pidFile) ? Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10) : undefined;",
            "if (command === 'status') process.stdout.write(pid ? `control: running\\npid: ${pid}\\ninstances: 0\\n` : 'control: stopped\\n');",
            "else if (command === 'overview') process.stdout.write(JSON.stringify({ instances: [] }));",
            "else if (command === 'stop') { if (pid) process.kill(pid, 'SIGTERM'); rmSync(pidFile, { force: true }); appendFileSync(runtimeLog, 'stop\\n'); }",
            "else if (command === 'start') appendFileSync(runtimeLog, 'start\\n');",
            "else process.exit(2);",
            "",
        ].join("\n"), "utf8");
        await chmod(oldCli, 0o755);
        await symlink("versions/9.8.7-running", currentLink);

        const daemon = resolve(activatedVersionDirectory, "test-runtime", "ControlDaemon.js");
        await writeFile(daemon, "setInterval(() => {}, 1000);\n", "utf8");
        liveControl = spawn(process.execPath, [daemon], { stdio: "ignore" });
        await writeFile(resolve(devshellHome, "control", "control.pid"), `${liveControl.pid}\n`, "utf8");

        await mkdir(resolve(workerBinDirectory, workerAsset));
        await symlink(workerAsset, resolve(workerBinDirectory, "devshell-worker"));

        const fakePnpm = resolve(fakeBin, "pnpm");
        await writeFile(fakePnpm, [
            "#!/usr/bin/env node",
            "import { mkdirSync, writeFileSync } from 'node:fs';",
            "import { resolve } from 'node:path';",
            "const args = process.argv.slice(2);",
            "const deploy = args.indexOf('deploy');",
            "if (deploy >= 0) {",
            "  const out = resolve(args[deploy + 1]);",
            "  mkdirSync(resolve(out, 'dist'), { recursive: true });",
            "  writeFileSync(resolve(out, 'package.json'), JSON.stringify({ name: '@portable-devshell/cli', version: '0.0.0', type: 'module', bin: { devshell: './dist/CliMain.js' } }));",
            "  writeFileSync(resolve(out, 'dist', 'CliMain.js'), `#!/usr/bin/env node\\nif ((process.argv[2] ?? 'status') === 'status') process.stdout.write('control: stopped\\\\n'); else process.exit(2);\\n`);",
            "}",
            "",
        ].join("\n"), "utf8");
        await chmod(fakePnpm, 0o755);

        server = createServer((request, response) => {
            if (request.url?.endsWith(`/${workerAsset}.sha256`)) {
                response.end(`${workerSha}  ${workerAsset}\n`);
                return;
            }
            if (request.url?.endsWith(`/${workerAsset}`)) {
                response.end(workerBytes);
                return;
            }
            response.statusCode = 404;
            response.end("missing");
        });
        await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
        const address = server.address();
        assert.ok(typeof address === "object" && address !== null);

        const result = await runProcess(process.execPath, [resolve(repositoryRoot, "scripts", "install-local.mjs")], {
            ...process.env,
            HOME: home,
            PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
            PORTABLE_DEVSHELL_BIN_DIR: binDirectory,
            PORTABLE_DEVSHELL_HOME: devshellHome,
            PORTABLE_DEVSHELL_INSTALL_ROOT: installRoot,
            PORTABLE_DEVSHELL_WORKER_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}`,
            XDG_DATA_HOME: resolve(root, "data"),
        });

        assert.notEqual(result.code, 0, `${result.stdout}${result.stderr}`);
        assert.match(result.stderr, /Unsupported active installation entry/u);
        assert.equal(await readlink(currentLink), "versions/9.8.7-running");
        assert.equal(await readFile(runtimeLog, "utf8").catch(() => ""), "");
        assert.doesNotThrow(() => process.kill(liveControl.pid, 0));
    } finally {
        liveControl?.kill("SIGKILL");
        if (server !== undefined) {
            await new Promise((resolveClose) => server.close(() => resolveClose()));
        }
        await rm(root, { force: true, recursive: true });
    }
});

test("install-local never downgrades after the new generation reaches real runtime restore", {
    skip: process.platform === "win32",
}, async () => {
    const root = await createTestTempDirectory("install-local-real-runtime-failure-test");
    const home = resolve(root, "home");
    const installRoot = resolve(root, "installed");
    const binDirectory = resolve(root, "bin");
    const devshellHome = resolve(root, "devshell-home");
    const fakeBin = resolve(root, "fake-bin");
    const runtimeLog = resolve(root, "runtime.log");
    const activatedVersionDirectory = resolve(installRoot, "versions", "9.8.7-running");
    const currentLink = resolve(installRoot, "current");
    const workerBinDirectory = resolve(devshellHome, "bin");
    const hostTarget = resolveHostTarget();
    const workerAsset = `devshell-worker-${hostTarget}`;
    const workerBytes = Buffer.from("candidate-worker\n", "utf8");
    const workerSha = createHash("sha256").update(workerBytes).digest("hex");
    let liveControl;
    let server;

    try {
        await mkdir(resolve(activatedVersionDirectory, "custom"), { recursive: true });
        await mkdir(resolve(activatedVersionDirectory, "test-runtime"), { recursive: true });
        await mkdir(resolve(devshellHome, "control"), { recursive: true });
        await mkdir(workerBinDirectory, { recursive: true });
        await mkdir(fakeBin, { recursive: true });
        await mkdir(home, { recursive: true });

        await writeFile(resolve(activatedVersionDirectory, "package.json"), `${JSON.stringify({
            name: "portable-devshell",
            version: "9.8.7-running",
            type: "module",
            bin: { devshell: "./custom/devshell-entry.js" },
        })}\n`, "utf8");
        const oldCli = resolve(activatedVersionDirectory, "custom", "devshell-entry.js");
        await writeFile(oldCli, [
            "#!/usr/bin/env node",
            "import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';",
            `const pidFile = ${JSON.stringify(resolve(devshellHome, "control", "control.pid"))};`,
            `const runtimeLog = ${JSON.stringify(runtimeLog)};`,
            "const command = process.argv[2] ?? 'status';",
            "const pid = existsSync(pidFile) ? Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10) : undefined;",
            "if (command === 'status') process.stdout.write(pid ? `control: running\\npid: ${pid}\\ninstances: 0\\n` : 'control: stopped\\n');",
            "else if (command === 'overview') process.stdout.write(JSON.stringify({ instances: [] }));",
            "else if (command === 'stop') { if (pid) process.kill(pid, 'SIGTERM'); rmSync(pidFile, { force: true }); appendFileSync(runtimeLog, 'stop\\n'); }",
            "else if (command === 'start') appendFileSync(runtimeLog, 'old-start\\n');",
            "else process.exit(2);",
            "",
        ].join("\n"), "utf8");
        await chmod(oldCli, 0o755);
        await symlink("versions/9.8.7-running", currentLink);

        const daemon = resolve(activatedVersionDirectory, "test-runtime", "ControlDaemon.js");
        await writeFile(daemon, "setInterval(() => {}, 1000);\n", "utf8");
        liveControl = spawn(process.execPath, [daemon], { stdio: "ignore" });
        await writeFile(resolve(devshellHome, "control", "control.pid"), `${liveControl.pid}\n`, "utf8");

        await writeFile(resolve(workerBinDirectory, workerAsset), "old-worker\n", "utf8");
        await symlink(workerAsset, resolve(workerBinDirectory, "devshell-worker"));

        const fakePnpm = resolve(fakeBin, "pnpm");
        await writeFile(fakePnpm, [
            "#!/usr/bin/env node",
            "import { mkdirSync, writeFileSync } from 'node:fs';",
            "import { resolve } from 'node:path';",
            "const args = process.argv.slice(2);",
            "const deploy = args.indexOf('deploy');",
            "if (deploy >= 0) {",
            "  const out = resolve(args[deploy + 1]);",
            "  mkdirSync(resolve(out, 'dist'), { recursive: true });",
            "  writeFileSync(resolve(out, 'package.json'), JSON.stringify({ name: '@portable-devshell/cli', version: '0.0.0', type: 'module', bin: { devshell: './dist/CliMain.js' } }));",
            "  writeFileSync(resolve(out, 'dist', 'CliMain.js'), `#!/usr/bin/env node\\nconst command = process.argv[2] ?? 'status';\\nif (command === 'status') process.stdout.write('control: stopped\\\\n'); else if (command === 'start') { process.stderr.write('real-state start failure\\\\n'); process.exit(1); } else process.exit(0);\\n`);",
            "}",
            "",
        ].join("\n"), "utf8");
        await chmod(fakePnpm, 0o755);

        server = createServer((request, response) => {
            if (request.url?.endsWith(`/${workerAsset}.sha256`)) {
                response.end(`${workerSha}  ${workerAsset}\n`);
                return;
            }
            if (request.url?.endsWith(`/${workerAsset}`)) {
                response.end(workerBytes);
                return;
            }
            response.statusCode = 404;
            response.end("missing");
        });
        await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
        const address = server.address();
        assert.ok(typeof address === "object" && address !== null);

        const result = await runProcess(process.execPath, [resolve(repositoryRoot, "scripts", "install-local.mjs")], {
            ...process.env,
            HOME: home,
            PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
            PORTABLE_DEVSHELL_BIN_DIR: binDirectory,
            PORTABLE_DEVSHELL_HOME: devshellHome,
            PORTABLE_DEVSHELL_INSTALL_ROOT: installRoot,
            PORTABLE_DEVSHELL_WORKER_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}`,
            XDG_DATA_HOME: resolve(root, "data"),
        });

        assert.notEqual(result.code, 0, `${result.stdout}${result.stderr}`);
        assert.match(result.stderr, /Automatic downgrade is disabled/iu);
        assert.equal(await readlink(currentLink), `versions/${CURRENT_DEVELOPMENT_VERSION}`);
        assert.deepEqual((await readFile(runtimeLog, "utf8")).trim().split("\n"), ["stop"]);
        assert.equal(await readFile(resolve(workerBinDirectory, workerAsset), "utf8"), "candidate-worker\n");
        const recoveryDirectories = (await readdir(installRoot)).filter((name) => name.startsWith(".worker-activation-backup-"));
        assert.equal(recoveryDirectories.length, 1);
        assert.equal(
            await readFile(resolve(installRoot, recoveryDirectories[0], "host-worker"), "utf8"),
            "old-worker\n",
        );
    } finally {
        liveControl?.kill("SIGKILL");
        await new Promise((resolveClose) => server?.close(() => resolveClose()));
        await rm(root, { force: true, recursive: true });
    }
});
