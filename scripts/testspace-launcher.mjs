import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { resolveTestspaceLaunchPlan } from "./testspace/TestspaceConfig.mjs";
import {
    ensureLinuxTestspaceNamespace,
    runInsideTestspaceNamespace,
    runWithoutLinuxNamespace,
    stopLinuxTestspaceNamespace,
} from "./testspace/TestspaceNamespace.mjs";
import { resolveTestspaceRoot } from "./testspace/TestspaceRuntime.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const scriptPath = fileURLToPath(new URL("./testspace.mjs", import.meta.url));
const supervisorPath = fileURLToPath(new URL("./testspace/TestspaceNamespaceSupervisor.py", import.meta.url));
const argv = process.argv.slice(2);
const { command, prepare, runtimeArgv } = resolveTestspaceLaunchPlan(argv);
const root = resolveTestspaceRoot(repoRoot, process.env.DEVSHELL_TESTSPACE_ROOT);

if (prepare) {
    run("pnpm", ["build"]);
    run("pnpm", ["test:prepare"]);
}

let status;
if (process.platform === "linux") {
    const namespace = await ensureLinuxTestspaceNamespace(root, {
        cwd: repoRoot,
        supervisorPath,
    });
    try {
        status = runInsideTestspaceNamespace(namespace, scriptPath, runtimeArgv, { cwd: repoRoot });
    } finally {
        const discardNamespace = command === "stop"
            || (namespace.created && command !== "start")
            || (namespace.created && command === "start" && status !== 0);
        if (discardNamespace) {
            await stopLinuxTestspaceNamespace(namespace).catch((error) => {
                process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
                if (status === 0) status = 1;
            });
        }
    }
} else {
    status = runWithoutLinuxNamespace(root, scriptPath, runtimeArgv, {
        cwd: repoRoot,
        platform: process.platform,
    });
}

process.exitCode = status;

function run(executable, args) {
    const result = spawnSync(executable, args, {
        cwd: repoRoot,
        env: process.env,
        stdio: "inherit",
    });
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0) {
        throw new Error(`${executable} ${args.join(" ")} failed with ${String(result.status)}`);
    }
}
