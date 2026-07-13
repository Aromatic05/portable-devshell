import { chmod } from "node:fs/promises";

import type { WorkerTarget } from "../target/WorkerTarget.js";

export async function ensureWorkerExecutablePermissions(path: string, target: WorkerTarget): Promise<void> {
    if (target.os === "windows") {
        return;
    }

    await chmod(path, 0o755);
}
