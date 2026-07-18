import { resolvePreparedWorker, runCommand } from "./AcceptanceSupport.mjs";
const worker = resolvePreparedWorker();
runCommand("pnpm", ["test"], {
    env: { ...process.env, PORTABLE_DEVSHELL_TEST_WORKER_PATH: worker },
    inherit: true
});
