import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

test("incremental package builds remove obsolete dist artifacts", { timeout: 120_000 }, async () => {
    for (const packageName of ["core", "mcp"]) {
        const marker = resolve(
            repositoryRoot,
            "packages",
            packageName,
            "dist",
            "__obsolete-build-output__.js"
        );
        await mkdir(resolve(marker, ".."), { recursive: true });
        await writeFile(marker, "throw new Error('obsolete output was loaded');\n", "utf8");

        try {
            const pnpmArgs = ["--filter", `@portable-devshell/${packageName}`, "run", "build"];
            const result = spawnSync(
                process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "pnpm",
                process.platform === "win32" ? ["/d", "/s", "/c", ["pnpm", ...pnpmArgs].join(" ")] : pnpmArgs,
                {
                    cwd: repositoryRoot,
                    encoding: "utf8",
                    timeout: 120_000,
                    windowsHide: true
                }
            );
            assert.equal(
                result.status,
                0,
                `${result.error?.stack ?? ""}\n${result.stdout ?? ""}${result.stderr ?? ""}`
            );
            await assert.rejects(() => lstat(marker), { code: "ENOENT" });
        } finally {
            await rm(marker, { force: true });
        }
    }
});
