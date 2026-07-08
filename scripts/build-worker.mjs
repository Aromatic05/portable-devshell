import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const workerSource = resolve(repoRoot, "target/debug/devshell-worker");
const bundledWorkerPath = resolve(repoRoot, "packages/core/assets/devshell-worker");
const copyOnly = process.argv.includes("--copy-only");

if (!copyOnly) {
    run("cargo", ["build", "-p", "devshell-worker", "--manifest-path", resolve(repoRoot, "Cargo.toml")]);
}

mkdirSync(dirname(bundledWorkerPath), { recursive: true });
copyFileSync(workerSource, bundledWorkerPath);
chmodSync(bundledWorkerPath, 0o755);

function run(command, args) {
    const result = spawnSync(command, args, {
        cwd: repoRoot,
        stdio: "inherit"
    });

    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
}
