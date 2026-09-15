import { fileURLToPath } from "node:url";

export function resolveControlWebAssetsDirectory(moduleUrl: string = import.meta.url): string {
    return fileURLToPath(new URL("../../../../web/dist/", moduleUrl));
}
