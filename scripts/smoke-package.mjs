import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";

const archiveArgument = process.argv.slice(2).find((argument) => argument !== "--");
if (archiveArgument === undefined) {
    throw new Error("usage: node scripts/smoke-package.mjs <portable-devshell-app.tar.gz>");
}

const archive = isAbsolute(archiveArgument) ? archiveArgument : resolve(process.cwd(), archiveArgument);
const root = await mkdtemp(resolve(tmpdir(), "portable-devshell-package-smoke-"));
const app = resolve(root, "app");
const home = resolve(root, "home");
const runtime = resolve(root, "runtime");

try {
    await mkdir(app, { recursive: true });
    await mkdir(home, { recursive: true });
    await mkdir(runtime, { recursive: true });
    run("tar", ["-xzf", archive, "-C", app]);
    await assertNoSymlinks(app);

    const cli = resolve(app, "dist", "cli", "CliMain.js");
    const result = spawnSync(process.execPath, [cli, "status"], {
        encoding: "utf8",
        env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            LOCALAPPDATA: resolve(home, "AppData", "Local"),
            PORTABLE_DEVSHELL_HOME: resolve(home, ".devshell"),
            XDG_RUNTIME_DIR: runtime
        }
    });
    if (result.error !== undefined) {
        throw result.error;
    }
    if (result.status !== 0 || !result.stdout.includes("control: stopped")) {
        throw new Error(
            `packaged CLI smoke failed (${result.status ?? "unknown"})\n${result.stdout}${result.stderr}`
        );
    }

    process.stdout.write("package smoke passed\n");
} finally {
    await rm(root, { force: true, recursive: true });
}

async function assertNoSymlinks(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = resolve(directory, entry.name);
        const metadata = await lstat(path);
        if (metadata.isSymbolicLink()) {
            throw new Error(`portable app archive contains a symbolic link: ${path}`);
        }
        if (metadata.isDirectory()) {
            await assertNoSymlinks(path);
        }
    }
}

function run(command, args) {
    const result = spawnSync(command, args, { encoding: "utf8" });
    if (result.error !== undefined) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(" ")} failed (${result.status ?? "unknown"})\n${result.stdout}${result.stderr}`);
    }
}
