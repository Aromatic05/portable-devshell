import { spawnSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const workerArgument = process.argv[2];
if (workerArgument === undefined) {
    throw new Error(
        "usage: node scripts/smoke-reverse-worker.mjs <worker executable>",
    );
}

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const worker = isAbsolute(workerArgument)
    ? workerArgument
    : resolve(repositoryRoot, workerArgument);
const loader = resolve(
    repositoryRoot,
    "packages",
    "mcp",
    "test",
    "RegisterWorkspacePackages.mjs",
);
const testFile = resolve(
    repositoryRoot,
    "packages",
    "control",
    "test",
    "integration",
    "ReverseRealWorker.test.ts",
);

const result = spawnSync(
    process.execPath,
    [
        "--import",
        "tsx",
        "--import",
        pathToFileURL(loader).href,
        "--test",
        "--test-concurrency=1",
        testFile,
    ],
    {
        cwd: repositoryRoot,
        env: {
            ...process.env,
            PORTABLE_DEVSHELL_TEST_WATCHDOG_MS: "60000",
            PORTABLE_DEVSHELL_TEST_WORKER_PATH: worker,
            TSX_TSCONFIG_PATH: resolve(repositoryRoot, "tsconfig.test.json"),
        },
        stdio: "inherit",
        windowsHide: true,
    },
);

if (result.error !== undefined) {
    throw result.error;
}
if (result.status !== 0) {
    throw new Error(
        `reverse worker smoke failed with exit code ${result.status ?? "unknown"}`,
    );
}
process.stdout.write("reverse worker smoke passed\n");
