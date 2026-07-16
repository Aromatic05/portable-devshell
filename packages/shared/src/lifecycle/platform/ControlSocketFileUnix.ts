import { chmod, mkdir } from "node:fs/promises";

import { removeControlIpcEndpoint } from "./ControlIpcEndpoint.js";

export class ControlSocketFileUnix {
    async ensureRuntimeDir(runtimeDir: string): Promise<void> {
        await mkdir(runtimeDir, { mode: 0o700, recursive: true });
        await chmod(runtimeDir, 0o700);
    }

    async remove(path: string): Promise<void> {
        await removeControlIpcEndpoint(path);
    }
}
