import { readFile } from "node:fs/promises";

import {
    parseExtensionManifest,
    type ExtensionManifest,
} from "@portable-devshell/extension";

import type { ExtensionPathLayout } from "../state/Layout.js";
import { assertPlainDirectory, assertPlainFile } from "./Paths.js";

export async function readExtensionManifest(
    paths: ExtensionPathLayout,
    id: string,
    generation: string,
): Promise<ExtensionManifest> {
    const codeDirectory = paths.generationDirectory(id, generation);
    await assertPlainDirectory(
        codeDirectory,
        `Extension generation directory for ${id}`,
    );
    const manifestPath = paths.manifestFile(id, generation);
    await assertPlainFile(manifestPath, `Extension manifest for ${id}`);
    const manifest = parseExtensionManifest(
        JSON.parse(await readFile(manifestPath, "utf8")) as unknown,
    );
    if (manifest.id !== id) {
        throw new Error(
            `Extension generation ${generation} declares id ${manifest.id}, expected ${id}.`,
        );
    }
    return manifest;
}
