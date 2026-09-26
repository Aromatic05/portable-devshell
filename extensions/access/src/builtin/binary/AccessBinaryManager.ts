import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
    access,
    chmod,
    mkdir,
    readFile,
    rename,
    rm,
    writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";

import type { ExtensionProcessCapability } from "@portable-devshell/extension";

import type { AccessProviderKind } from "../Config.js";

const gunzipAsync = promisify(gunzip);

export interface AccessManagedBinaryAsset {
    archive: "raw" | "tar.gz";
    sha256: string;
    url: string;
    version: string;
}

export interface AccessBinaryManagerOptions {
    fetch?: typeof globalThis.fetch;
    platform?: NodeJS.Platform;
    arch?: NodeJS.Architecture;
    processes?: ExtensionProcessCapability;
    resolveManagedAsset?: (
        kind: "cloudflared" | "frp",
        platform: NodeJS.Platform,
        arch: NodeJS.Architecture,
    ) => AccessManagedBinaryAsset;
}

export class AccessBinaryManager {
    readonly #arch: NodeJS.Architecture;
    readonly #binDirectory: string;
    readonly #fetch?: typeof globalThis.fetch;
    readonly #platform: NodeJS.Platform;
    readonly #processes?: ExtensionProcessCapability;
    readonly #resolveManagedAsset: NonNullable<
        AccessBinaryManagerOptions["resolveManagedAsset"]
    >;
    readonly #resolving = new Map<string, Promise<string>>();

    constructor(dataDirectory: string, options: AccessBinaryManagerOptions = {}) {
        this.#arch = options.arch ?? process.arch;
        this.#binDirectory = join(dataDirectory, "bin");
        this.#fetch = options.fetch;
        this.#platform = options.platform ?? process.platform;
        this.#processes = options.processes;
        this.#resolveManagedAsset =
            options.resolveManagedAsset ?? resolvePinnedManagedAsset;
    }

    async resolve(kind: AccessProviderKind, override?: string): Promise<string> {
        if (override !== undefined) return override;
        if (kind === "ssh") return "ssh";
        let resolving = this.#resolving.get(kind);
        if (resolving === undefined) {
            resolving = this.#resolveManaged(kind).finally(() =>
                this.#resolving.delete(kind),
            );
            this.#resolving.set(kind, resolving);
        }
        return await resolving;
    }

    async #resolveManaged(kind: "cloudflared" | "frp"): Promise<string> {
        await mkdir(this.#binDirectory, { mode: 0o700, recursive: true });
        const asset = this.#resolveManagedAsset(
            kind,
            this.#platform,
            this.#arch,
        );
        assertManagedBinaryVersion(asset.version);
        const executableName = kind === "frp" ? "frpc" : "cloudflared";
        const executable = join(
            this.#binDirectory,
            `${executableName}-${asset.version}${this.#platform === "win32" ? ".exe" : ""}`,
        );
        if (await isExecutable(executable, this.#platform)) return executable;

        const downloaded = await this.#download(
            asset.url,
            `Failed to download ${kind} binary`,
        );
        verifySha256(downloaded, asset.sha256, `${kind} ${asset.version}`);
        const bytes = asset.archive === "tar.gz"
            ? await extractExecutableFromTarGz(
                  downloaded,
                  executableName,
              )
            : downloaded;
        const temporary = `${executable}.${randomUUID()}.tmp`;
        await writeFile(temporary, bytes, { mode: 0o700 });
        try {
            if (this.#platform !== "win32") await chmod(temporary, 0o700);
            await rename(temporary, executable);
        } catch (error) {
            await rm(temporary, { force: true }).catch(() => undefined);
            throw error;
        }
        return executable;
    }

    async #download(url: string, message: string): Promise<Buffer> {
        if (this.#processes !== undefined)
            return await this.#downloadWithManagedProcess(url, message);
        const fetch = this.#fetch ?? globalThis.fetch;
        let response: Response;
        try {
            response = await fetch(url, {
                headers: {
                    accept: "application/vnd.github+json",
                    "user-agent": "portable-devshell-access",
                },
                redirect: "follow",
                signal: AbortSignal.timeout(120_000),
            });
        } catch (error) {
            throw new Error(`${message}: ${error instanceof Error ? error.message : String(error)}.`, { cause: error });
        }
        if (!response.ok)
            throw new Error(`${message}: HTTP ${response.status}.`);
        return Buffer.from(await response.arrayBuffer());
    }

    async #downloadWithManagedProcess(
        url: string,
        message: string,
    ): Promise<Buffer> {
        const temporary = join(
            this.#binDirectory,
            `.download-${randomUUID()}.tmp`,
        );
        let stderr = "";
        const worker = fileURLToPath(
            new URL("./DownloadWorker.js", import.meta.url),
        );
        try {
            const child = await this.#processes!.start({
                args: [worker, url, temporary],
                command: process.execPath,
            });
            const removeStderr = child.onStderr((chunk) => {
                stderr = `${stderr}${chunk}`.slice(-16 * 1024);
            });
            let exit;
            try {
                exit = await child.closed;
            } finally {
                removeStderr();
            }
            if (exit.code !== 0) {
                const detail = stderr.trim();
                throw new Error(
                    `${message}: downloader exited with code ${exit.code ?? "unknown"}${detail.length === 0 ? "" : `: ${detail}`}.`,
                );
            }
            return await readFile(temporary);
        } finally {
            await rm(temporary, { force: true }).catch(() => undefined);
        }
    }

}

function resolvePinnedManagedAsset(
    kind: "cloudflared" | "frp",
    platform: NodeJS.Platform,
    arch: NodeJS.Architecture,
): AccessManagedBinaryAsset {
    const target = platformArch(platform, arch);
    const targetKey = `${target.os}-${target.arch}`;
    const pin = kind === "cloudflared" ? CLOUDFLARED_PIN : FRP_PIN;
    const asset = pin.assets[targetKey];
    if (asset !== undefined) {
        return {
            archive: asset.archive,
            sha256: asset.sha256,
            url: `https://github.com/${pin.repository}/releases/download/${pin.tag}/${asset.name}`,
            version: pin.version,
        };
    }
    throw new Error(
        `Access managed ${kind} ${pin.version} does not support ${platform}/${arch}.`,
    );
}

type PinnedAsset = Pick<AccessManagedBinaryAsset, "archive" | "sha256"> & {
    name: string;
};

interface ManagedBinaryPin {
    assets: Readonly<Record<string, PinnedAsset>>;
    repository: string;
    tag: string;
    version: string;
}

const CLOUDFLARED_PIN: ManagedBinaryPin = {
    assets: {
        "darwin-amd64": {
            archive: "tar.gz",
            name: "cloudflared-darwin-amd64.tgz",
            sha256: "d1155d0837487f261183b15c1eab6c4ebcad9dc49b94675f1524c3564cea3977",
        },
        "darwin-arm64": {
            archive: "tar.gz",
            name: "cloudflared-darwin-arm64.tgz",
            sha256: "587c2cfb1c230fe36c7fa7727da78be459dae028cabe8c001291999350f07095",
        },
        "linux-amd64": {
            archive: "raw",
            name: "cloudflared-linux-amd64",
            sha256: "77e26d8d900e0b8469f416239d14b5f296525fdf79fee6f511ef55609e3fbac2",
        },
        "linux-arm64": {
            archive: "raw",
            name: "cloudflared-linux-arm64",
            sha256: "aaeb2d7d0da3614634c7e03ab13487a1522c2e79165ed2929cfe23d5e95b326d",
        },
        "windows-amd64": {
            archive: "raw",
            name: "cloudflared-windows-amd64.exe",
            sha256: "f096265ec2fcbe9bb6e2d64268db167ced3fcbb83d894bdb9e2fcdb26f2ea7e2",
        },
    },
    repository: "cloudflare/cloudflared",
    tag: "2026.9.3",
    version: "2026.9.3",
};

const FRP_PIN: ManagedBinaryPin = {
    assets: {
        "darwin-amd64": {
            archive: "tar.gz",
            name: "frp_0.71.0_darwin_amd64.tar.gz",
            sha256: "1b1b4e2f1836e21e8733f1dddaacd4ed9ae67d7dbee39046b9d7b7eda6253637",
        },
        "darwin-arm64": {
            archive: "tar.gz",
            name: "frp_0.71.0_darwin_arm64.tar.gz",
            sha256: "45be02b186860d375ed49a8941ae9569628a54bf14e67fc36b29c98c99dabcc6",
        },
        "linux-amd64": {
            archive: "tar.gz",
            name: "frp_0.71.0_linux_amd64.tar.gz",
            sha256: "84f27e39f11169f7adcef8e8b70c9329de17747b1f14dad9fb95eef5682ea716",
        },
        "linux-arm64": {
            archive: "tar.gz",
            name: "frp_0.71.0_linux_arm64.tar.gz",
            sha256: "f33c293c275d8fc68c654b6fba8f10b2551d6463d09a9fc9cffb7227eae82266",
        },
    },
    repository: "fatedier/frp",
    tag: "v0.71.0",
    version: "0.71.0",
};

function platformArch(
    platform: NodeJS.Platform,
    arch: NodeJS.Architecture,
): { arch: string; os: string } {
    const os =
        platform === "win32"
            ? "windows"
            : platform === "darwin"
              ? "darwin"
              : platform === "linux"
                ? "linux"
                : undefined;
    const normalizedArch = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : undefined;
    if (os === undefined || normalizedArch === undefined) {
        throw new Error(`Access binary download does not support ${platform}/${arch}.`);
    }
    return { arch: normalizedArch, os };
}

function assertManagedBinaryVersion(version: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(version)) {
        throw new TypeError("Access managed binary version is invalid.");
    }
}

function verifySha256(bytes: Buffer, expected: string, label: string): void {
    if (!/^[a-f0-9]{64}$/u.test(expected)) {
        throw new TypeError(`${label} has an invalid SHA-256 pin.`);
    }
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expected) {
        throw new Error(
            `${label} integrity check failed: expected sha256:${expected}, received sha256:${actual}.`,
        );
    }
}

async function isExecutable(path: string, platform: NodeJS.Platform): Promise<boolean> {
    try {
        await access(path, platform === "win32" ? constants.F_OK : constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

async function extractExecutableFromTarGz(
    compressed: Buffer,
    executableName: string,
): Promise<Buffer> {
    const archive = await gunzipAsync(compressed);
    let offset = 0;
    while (offset + 512 <= archive.length) {
        const header = archive.subarray(offset, offset + 512);
        if (header.every((byte) => byte === 0)) break;
        const name = readTarString(header, 0, 100);
        const prefix = readTarString(header, 345, 155);
        const path = prefix.length === 0 ? name : `${prefix}/${name}`;
        const sizeText = readTarString(header, 124, 12).replace(/\0.*$/u, "").trim();
        const size = sizeText.length === 0 ? 0 : Number.parseInt(sizeText, 8);
        if (!Number.isSafeInteger(size) || size < 0)
            throw new TypeError("Downloaded tar archive contains an invalid entry size.");
        const bodyOffset = offset + 512;
        const bodyEnd = bodyOffset + size;
        if (bodyEnd > archive.length)
            throw new TypeError("Downloaded tar archive is truncated.");
        const type = String.fromCharCode(header[156] ?? 0);
        if ((type === "0" || type === "\0") && basename(path) === executableName)
            return Buffer.from(archive.subarray(bodyOffset, bodyEnd));
        offset = bodyOffset + Math.ceil(size / 512) * 512;
    }
    throw new Error(`Downloaded archive does not contain ${executableName}.`);
}

function readTarString(buffer: Buffer, offset: number, length: number): string {
    const end = buffer.indexOf(0, offset);
    const bounded = end === -1 || end > offset + length ? offset + length : end;
    return buffer.subarray(offset, bounded).toString("utf8").trim();
}
