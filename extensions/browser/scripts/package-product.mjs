import { cp, mkdir, rename, rm, stat, readFile, writeFile, copyFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const output = process.argv[2];
if (!output) throw new Error("Usage: pnpm package-product <new product directory> [prepared runtime directory]");
const destination = resolve(output);
try { await stat(destination); throw new Error("Product directory already exists."); }
catch (error) { if (error.code !== "ENOENT") throw error; }
const staging = join(dirname(destination), ".browser-product-" + randomUUID());
await mkdir(staging, { recursive: true });
try {
    await cp(new URL("../dist/", import.meta.url), join(staging, "extension"), { recursive: true });
    await cp(new URL("../README.md", import.meta.url), join(staging, "README.md"));
    const runtime = join(staging, "runtime");
    const prepared = process.argv[3];
    if (prepared) {
        const source = resolve(prepared);
        const manifest = JSON.parse(await readFile(join(source, "runtime.json"), "utf8"));
        const cli = JSON.parse(await readFile(join(source, "node_modules/@playwright/cli/package.json"), "utf8"));
        if (manifest.playwrightCli !== "0.1.25" || cli.version !== manifest.playwrightCli ||
            !["bin/node", "bin/node.exe"].includes(manifest.executable))
            throw new Error("Prepared runtime does not match the pinned Playwright CLI.");
        await mkdir(runtime);
        for (const directory of ["bin", "browsers", "node_modules"])
            await cp(join(source, directory), join(runtime, directory), { recursive: true });
        for (const name of ["Browser.mjs", "Files.mjs", "helper.mjs"])
            await copyFile(new URL("../runtime/" + name, import.meta.url), join(runtime, name));
        await copyFile(new URL("../dist/Wire.js", import.meta.url), join(runtime, "Wire.js"));
        await writeFile(join(runtime, "package.json"), JSON.stringify({ private: true, type: "module" }));
        await writeFile(join(runtime, "runtime.json"), JSON.stringify(manifest, null, 4));
    } else {
        await run(process.execPath, [fileURLToPath(new URL("./prepare-runtime.mjs", import.meta.url)), runtime], { timeout: 600000 });
    }
    await rename(staging, destination);
    console.log(destination);
} finally { await rm(staging, { recursive: true, force: true }); }
