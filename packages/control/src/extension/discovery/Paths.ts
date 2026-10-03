import { lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export function resolveContainedPath(
    root: string,
    candidate: string,
    label: string,
): string {
    if (isAbsolute(candidate))
        throw new TypeError(
            `${label} must be relative to the Extension generation.`,
        );
    const resolved = resolve(root, candidate);
    const relativePath = relative(root, resolved);
    if (
        relativePath === "" ||
        (!relativePath.startsWith("..") && !isAbsolute(relativePath))
    )
        return resolved;
    throw new TypeError(`${label} must stay inside the Extension generation.`);
}

export async function assertPlainDirectory(
    path: string,
    label: string,
): Promise<void> {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new TypeError(
            `${label} must be a real directory, not a symlink.`,
        );
    }
}

export async function assertPlainFile(
    path: string,
    label: string,
): Promise<void> {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new TypeError(`${label} must be a regular file, not a symlink.`);
    }
}

export function isMissing(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
    );
}

export function isDirectoryNotEmpty(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOTEMPTY"
    );
}
