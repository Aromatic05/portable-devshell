import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const playwrightCliVersion = "0.1.25";
const playwrightCoreVersion = "1.66.0-alpha-2026-11-18";

/** Temporary upstream compatibility fix for fractional CDP device dimensions.
 * The pinned Playwright frame protocol accepts only integer viewport sizes.
 * Apply only to a staged, version-matched runtime, never an installed runtime. */
async function normalizeScreencast(root) {
    const core = join(root, "node_modules", "playwright-core");
    const manifest = JSON.parse(await readFile(join(core, "package.json"), "utf8"));
    if (manifest.version !== playwrightCoreVersion)
        throw new Error("Review the screencast compatibility fix for this Playwright version.");
    const path = join(core, "lib", "coreBundle.js");
    const content = await readFile(path, "utf8");
    const before = "viewportWidth: payload.metadata.deviceWidth,\n          viewportHeight: payload.metadata.deviceHeight";
    const after = "viewportWidth: Math.round(payload.metadata.deviceWidth),\n          viewportHeight: Math.round(payload.metadata.deviceHeight)";
    if (content.includes(after) && !content.includes(before)) return;
    if (content.split(before).length !== 2 || content.includes(after))
        throw new Error("Unexpected Playwright screencast implementation.");
    await writeFile(path, content.replace(before, after));
}

export async function stageRuntime(root) {
    await normalizeScreencast(root);
    for (const file of ["helper.mjs", "Browser.mjs", "Attached.mjs", "Files.mjs"])
        await copyFile(new URL("../runtime/" + file, import.meta.url), join(root, file));
    await copyFile(new URL("../dist/Wire.js", import.meta.url), join(root, "Wire.js"));
}
