import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TEST_TEMP_NAMESPACE = "devshell-test";

export async function resolveTestTempNamespace() {
    await mkdir(join(tmpdir(), TEST_TEMP_NAMESPACE), { recursive: true });
    return await realpath(join(tmpdir(), TEST_TEMP_NAMESPACE));
}

export async function createTestTempDirectory(label = "test") {
    const sanitized = label.replaceAll(/[^A-Za-z0-9._-]/gu, "-") || "test";
    const namespace = await resolveTestTempNamespace();
    return await realpath(await mkdtemp(join(namespace, `${sanitized}-`)));
}
