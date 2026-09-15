import { open } from "node:fs/promises";

import { createBLAKE3 } from "hash-wasm";

export async function artifactBlake3(bytes: Uint8Array): Promise<string> {
    const hasher = await createBLAKE3();
    hasher.init();
    hasher.update(bytes);
    return hasher.digest("hex");
}

export async function artifactHashFile(path: string): Promise<{ blake3: string; bytes: number }> {
    const file = await open(path, "r");
    try {
        const hasher = await createBLAKE3();
        hasher.init();
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let bytes = 0;
        while (true) {
            const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
            if (bytesRead === 0) {
                break;
            }
            hasher.update(buffer.subarray(0, bytesRead));
            bytes += bytesRead;
        }
        return { blake3: hasher.digest("hex"), bytes };
    } finally {
        await file.close();
    }
}

export async function createArtifactHasher() {
    const hasher = await createBLAKE3();
    hasher.init();
    return hasher;
}

export function updateManifestHash(
    hasher: Awaited<ReturnType<typeof createBLAKE3>>,
    entry: {
        contentBlake3?: string;
        entryType: "directory" | "file";
        mode: number;
        modifiedAtSeconds: number;
        relativePath: string;
        size: number;
    }
): void {
    hasher.update(Uint8Array.of(entry.entryType === "directory" ? 0 : 1));
    const path = Buffer.from(entry.relativePath, "utf8");
    hasher.update(u64(path.length));
    hasher.update(path);
    hasher.update(u32(entry.mode));
    hasher.update(u64(entry.size));
    hasher.update(u64(entry.modifiedAtSeconds));
    const content = entry.contentBlake3 === undefined ? Buffer.alloc(0) : Buffer.from(entry.contentBlake3, "ascii");
    hasher.update(u64(content.length));
    if (content.length > 0) {
        hasher.update(content);
    }
}

function u32(value: number): Buffer {
    const buffer = Buffer.allocUnsafe(4);
    buffer.writeUInt32BE(value >>> 0);
    return buffer;
}

function u64(value: number): Buffer {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`Invalid unsigned 64-bit value: ${value}`);
    }
    const buffer = Buffer.allocUnsafe(8);
    buffer.writeBigUInt64BE(BigInt(value));
    return buffer;
}
