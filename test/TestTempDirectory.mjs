import { rmSync } from "node:fs";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TEST_TEMP_NAMESPACE = "devshell-test";

const activeDirectories = new Set();

process.once("exit", cleanupTestTempDirectories);

export async function resolveTestTempNamespace() {
    await mkdir(join(tmpdir(), TEST_TEMP_NAMESPACE), { recursive: true });
    return await realpath(join(tmpdir(), TEST_TEMP_NAMESPACE));
}

export async function createTestTempDirectory(label = "test") {
    const sanitized = label.replaceAll(/[^A-Za-z0-9._-]/gu, "-") || "test";
    const namespace = await resolveTestTempNamespace();
    const directory = await realpath(await mkdtemp(join(namespace, `${sanitized}-`)));
    activeDirectories.add(directory);
    return directory;
}

export function cleanupTestTempDirectories() {
    for (const directory of activeDirectories) {
        try {
            rmSync(directory, { force: true, recursive: true });
        } finally {
            activeDirectories.delete(directory);
        }
    }
}
