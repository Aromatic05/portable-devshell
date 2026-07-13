import { unlink } from "node:fs/promises";

import { isWindowsNamedPipePath } from "@portable-devshell/shared";

export async function removeControlIpcEndpoint(
    path: string,
    unlinkFunction: (path: string) => Promise<unknown> = unlink
): Promise<void> {
    if (isWindowsNamedPipePath(path)) {
        return;
    }

    await unlinkFunction(path).catch(() => undefined);
}
