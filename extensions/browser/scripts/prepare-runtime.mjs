import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { playwrightCliVersion, stageRuntime } from "./Runtime.mjs";

const run = promisify(execFile);
const destination = process.argv[2];
if (!destination) throw new Error("Usage: pnpm prepare-runtime <empty output directory>");
const root = resolve(destination);
const executable = process.platform === "win32" ? "bin/node.exe" : "bin/node";
await mkdir(root, { recursive: false });
await mkdir(join(root, "bin"));
await copyFile(process.execPath, join(root, executable));
await chmod(join(root, executable), 0o755);
await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }));
const npmArgs = ["install", "--omit=dev", "--ignore-scripts", "--no-bin-links", "--no-audit", "--no-fund", "--save-exact", "@playwright/cli@" + playwrightCliVersion];
if (process.platform === "win32")
    await run(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", "npm", ...npmArgs], { cwd: root, timeout: 180000 });
else
    await run("npm", npmArgs, { cwd: root, timeout: 180000 });
await run(join(root, executable), [join(root, "node_modules", "playwright", "cli.js"), "install", "chromium", "--only-shell"], {
    cwd: root, timeout: 180000, env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: join(root, "browsers") },
});
await stageRuntime(root);
await writeFile(join(root, "runtime.json"), JSON.stringify({ executable, platform: process.platform, architecture: process.arch, playwrightCli: playwrightCliVersion }, null, 4));
console.log(root);
