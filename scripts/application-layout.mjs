import { lstat, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export class ApplicationLayoutError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = "ApplicationLayoutError";
    }
}

export function normalizeCliArguments(argumentsList) {
    const normalized = [...argumentsList];
    if (normalized[0] === "--") {
        normalized.shift();
    }
    return normalized;
}

export async function readPackageBinPath(packageRoot, command) {
    const manifestPath = resolve(packageRoot, "package.json");
    let source;
    try {
        source = await readFile(manifestPath, "utf8");
    } catch (error) {
        throw new ApplicationLayoutError(
            `Cannot read application package manifest at ${manifestPath}.`,
            { cause: error }
        );
    }

    let manifest;
    try {
        manifest = JSON.parse(source);
    } catch (error) {
        throw new ApplicationLayoutError(
            `Application package manifest at ${manifestPath} is not valid JSON.`,
            { cause: error }
        );
    }

    return resolvePackageBinPath(packageRoot, manifest, command);
}

export async function tryReadPackageBinPath(packageRoot, command) {
    try {
        return await readPackageBinPath(packageRoot, command);
    } catch (error) {
        if (error instanceof ApplicationLayoutError && error.cause?.code === "ENOENT") {
            return undefined;
        }
        throw error;
    }
}

export function resolvePackageBinPath(packageRoot, manifest, command) {
    const root = resolve(packageRoot);
    const binEntry = selectBinEntry(manifest, command);
    const relativePath = normalizeRelativeBinPath(binEntry, command);
    const absolutePath = resolve(root, relativePath);
    const pathFromRoot = relative(root, absolutePath);

    if (pathFromRoot === "" || pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
        throw new ApplicationLayoutError(
            `Package bin.${command} escapes package root: ${binEntry}`
        );
    }

    return {
        absolutePath,
        command,
        relativePath: pathFromRoot.split(sep).join("/")
    };
}

export async function writePortableApplicationManifest(packageRoot, options) {
    const command = options.command ?? "devshell";
    const bin = await readPackageBinPath(packageRoot, command);
    const version = requireNonEmptyString(options.version, "portable application version");
    const minimumNodeMajor = options.minimumNodeMajor;
    if (!Number.isSafeInteger(minimumNodeMajor) || minimumNodeMajor < 1) {
        throw new ApplicationLayoutError("minimumNodeMajor must be a positive integer.");
    }

    const manifest = {
        name: options.name ?? "portable-devshell",
        version,
        private: true,
        type: "module",
        bin: {
            [command]: `./${bin.relativePath}`
        },
        engines: {
            node: `>=${minimumNodeMajor}`
        }
    };

    await writeFile(
        resolve(packageRoot, "package.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
        "utf8"
    );
    return manifest;
}

export async function assertPackageBinFile(bin) {
    let metadata;
    try {
        metadata = await lstat(bin.absolutePath);
    } catch (error) {
        throw new ApplicationLayoutError(
            `Package bin.${bin.command} does not exist at ${bin.absolutePath}.`,
            { cause: error }
        );
    }

    if (metadata.isSymbolicLink()) {
        throw new ApplicationLayoutError(
            `Package bin.${bin.command} must not be a symbolic link: ${bin.absolutePath}`
        );
    }
    if (!metadata.isFile()) {
        throw new ApplicationLayoutError(
            `Package bin.${bin.command} is not a regular file: ${bin.absolutePath}`
        );
    }

    return bin;
}

function selectBinEntry(manifest, command) {
    if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
        throw new ApplicationLayoutError("Application package manifest must be an object.");
    }

    if (typeof manifest.bin === "string") {
        const defaultCommand = packageCommandName(manifest.name);
        if (defaultCommand !== command) {
            throw new ApplicationLayoutError(
                `Application package does not declare bin.${command}; string bin belongs to ${defaultCommand}.`
            );
        }
        return manifest.bin;
    }

    if (typeof manifest.bin !== "object" || manifest.bin === null || Array.isArray(manifest.bin)) {
        throw new ApplicationLayoutError(
            `Application package does not declare bin.${command}.`
        );
    }

    const entry = manifest.bin[command];
    if (entry === undefined) {
        throw new ApplicationLayoutError(
            `Application package does not declare bin.${command}.`
        );
    }
    return entry;
}

function normalizeRelativeBinPath(value, command) {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new ApplicationLayoutError(
            `Package bin.${command} must be a non-empty string.`
        );
    }
    if (isAbsolute(value)) {
        throw new ApplicationLayoutError(
            `Package bin.${command} must be relative: ${value}`
        );
    }

    const normalized = value.replaceAll("\\", "/").replace(/^\.\//u, "");
    if (normalized.length === 0) {
        throw new ApplicationLayoutError(
            `Package bin.${command} must be a non-empty string.`
        );
    }
    return normalized;
}

function packageCommandName(name) {
    if (typeof name !== "string" || name.length === 0) {
        throw new ApplicationLayoutError(
            "Application package with a string bin declaration must have a name."
        );
    }
    const segments = name.split("/");
    return segments.at(-1);
}

function requireNonEmptyString(value, label) {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new ApplicationLayoutError(`${label} must be a non-empty string.`);
    }
    return value;
}
