import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const scriptsDirectory = new URL("./", import.meta.url);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const testFiles = readdirSync(scriptsDirectory)
    .filter((name) => name.endsWith(".test.mjs"))
    .sort()
    .map((name) => fileURLToPath(new URL(name, scriptsDirectory)));

const result = spawnSync(process.execPath, ["--test", ...testFiles], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
});

if (result.error !== undefined) throw result.error;
process.exit(result.status ?? 1);
