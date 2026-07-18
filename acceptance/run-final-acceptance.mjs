import { commandAvailable, resolvePreparedWorker, runCommand } from "./AcceptanceSupport.mjs";

runCommand("pnpm", ["build"], { inherit: true });
runCommand("pnpm", ["typecheck"], { inherit: true });
runCommand("cargo", ["build", "--locked", "--workspace"], { inherit: true });
const worker = resolvePreparedWorker();
const env = { ...process.env, PORTABLE_DEVSHELL_TEST_WORKER_PATH: worker };
runCommand("pnpm", ["test"], { env, inherit: true });
runCommand("cargo", ["test", "--locked", "--workspace"], { inherit: true });
if (process.platform !== "win32" && commandAvailable("tmux", ["-V"])) {
    runCommand("pnpm", ["test:worker:tmux"], { env, inherit: true });
} else {
    process.stdout.write("tmux worker contracts: skipped (tmux unavailable or unsupported platform)\n");
}
runCommand(process.execPath, ["acceptance/run-real-worker-smoke.mjs"], { env, inherit: true });
runCommand(process.execPath, ["acceptance/run-mcp-smoke.mjs"], { env, inherit: true });
