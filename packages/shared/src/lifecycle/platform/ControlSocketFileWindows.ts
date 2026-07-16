import { mkdir } from "node:fs/promises";

import { removeControlIpcEndpoint } from "./ControlIpcEndpoint.js";

export class ControlSocketFileWindows {
    async ensureRuntimeDir(runtimeDir: string): Promise<void> {
        await mkdir(runtimeDir, { recursive: true });
    }

    async remove(path: string): Promise<void> {
        await removeControlIpcEndpoint(path);
    }
}
