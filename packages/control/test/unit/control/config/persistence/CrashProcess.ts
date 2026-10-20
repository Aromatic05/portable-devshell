import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("../../../../../../../", import.meta.url);

// Patch only the disposable writer process; the real filesystem and SQLite
// reach the selected boundary before SIGKILL prevents catch/finally recovery.
export function runPersistenceProcess(source: string, input: unknown, crash = false): string {
    const capture = mkdtempSync(join(tmpdir(), "pds-crash-output-"));
    const stdout = openSync(join(capture, "stdout"), "wx", 0o600);
    const stderr = openSync(join(capture, "stderr"), "wx", 0o600);
    const environment = { ...process.env };
    // Nested processes must not emit Node's binary test-runner protocol.
    delete environment.NODE_TEST_CONTEXT;
    try {
        const result = spawnSync(process.execPath, [
            "--import", "tsx",
            "--import", new URL("packages/mcp/test/RegisterWorkspacePackages.mjs", root).href,
            "--input-type=module", "-e", source, JSON.stringify(input),
        ], {
            cwd: fileURLToPath(root),
            encoding: "utf8",
            stdio: ["ignore", stdout, stderr],
            env: {
                ...environment,
                TSX_TSCONFIG_PATH: fileURLToPath(new URL("tsconfig.test.json", root)),
            },
            timeout: 20_000,
        });
        const diagnostic = readFileSync(join(capture, "stderr"), "utf8");
        assert.equal(result.error, undefined);
        assert.equal(result.signal, crash ? "SIGKILL" : null, diagnostic);
        assert.equal(result.status, crash ? null : 0, diagnostic);
        return readFileSync(join(capture, "stdout"), "utf8");
    } finally {
        closeSync(stdout);
        closeSync(stderr);
        rmSync(capture, { recursive: true, force: true });
    }
}
