import { constants } from "node:fs";
import {
    access,
    chmod,
    mkdir,
    rename,
    rm,
    writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";

import type { AccessProviderKind } from "../Config.js";

const gunzipAsync = promisify(gunzip);

interface ReleaseAsset {
    browser_download_url: string;
    name: string;
}

interface GithubRelease {
    assets: ReleaseAsset[];
    tag_name: string;
}

export interface AccessBinaryManagerOptions {
    fetch?: typeof globalThis.fetch;
    platform?: NodeJS.Platform;
    arch?: NodeJS.Architecture;
}

export class AccessBinaryManager {
    readonly #arch: NodeJS.Architecture;
    readonly #binDirectory: string;
    readonly #fetch: typeof globalThis.fetch;
    readonly #platform: NodeJS.Platform;
    readonly #resolving = new Map<string, Promise<string>>();

    constructor(dataDirectory: string, options: AccessBinaryManagerOptions = {}) {
        this.#arch = options.arch ?? process.arch;
        this.#binDirectory = join(dataDirectory, "bin");
        this.#fetch = options.fetch ?? globalThis.fetch;
        this.#platform = options.platform ?? process.platform;
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
        const executable = join(
            this.#binDirectory,
            `${kind === "frp" ? "frpc" : "cloudflared"}${this.#platform === "win32" ? ".exe" : ""}`,
        );
        if (await isExecutable(executable, this.#platform)) return executable;

        const release = await this.#release(
            kind === "frp" ? "fatedier/frp" : "cloudflare/cloudflared",
        );
        const asset =
            kind === "frp"
                ? selectFrpAsset(release, this.#platform, this.#arch)
                : selectCloudflaredAsset(release, this.#platform, this.#arch);
        const response = await this.#fetch(asset.browser_download_url, {
            headers: { "user-agent": "portable-devshell-access" },
            redirect: "follow",
            signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) {
            throw new Error(
                `Failed to download ${kind} binary: HTTP ${response.status}.`,
            );
        }
        const downloaded = Buffer.from(await response.arrayBuffer());
        const bytes = asset.name.endsWith(".tar.gz") || asset.name.endsWith(".tgz")
            ? await extractExecutableFromTarGz(
                  downloaded,
                  kind === "frp" ? "frpc" : "cloudflared",
              )
            : downloaded;
        const temporary = `${executable}.${process.pid}.tmp`;
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

    async #release(repository: string): Promise<GithubRelease> {
        const response = await this.#fetch(
            `https://api.github.com/repos/${repository}/releases/latest`,
            {
                headers: {
                    accept: "application/vnd.github+json",
                    "user-agent": "portable-devshell-access",
                },
                signal: AbortSignal.timeout(30_000),
            },
        );
        if (!response.ok) {
            throw new Error(
                `Failed to resolve latest ${repository} release: HTTP ${response.status}.`,
            );
        }
        const value = (await response.json()) as unknown;
        if (!isRecord(value) || typeof value.tag_name !== "string")
            throw new TypeError(`Latest ${repository} release metadata is invalid.`);
        if (!Array.isArray(value.assets))
            throw new TypeError(`Latest ${repository} release has no assets.`);
        const assets = value.assets.map((entry) => {
            if (
                !isRecord(entry) ||
                typeof entry.name !== "string" ||
                typeof entry.browser_download_url !== "string"
            ) {
                throw new TypeError(
                    `Latest ${repository} release contains an invalid asset.`,
                );
            }
            return {
                browser_download_url: entry.browser_download_url,
                name: entry.name,
            };
        });
        return { assets, tag_name: value.tag_name };
    }
}

function selectCloudflaredAsset(
    release: GithubRelease,
    platform: NodeJS.Platform,
    arch: NodeJS.Architecture,
): ReleaseAsset {
    const target = platformArch(platform, arch);
    const prefix = `cloudflared-${target.os}-${target.arch}`;
    const candidates = release.assets.filter((asset) => asset.name.startsWith(prefix));
    const preferred = candidates.find((asset) => {
        if (platform === "linux") return asset.name === prefix;
        if (platform === "win32") return asset.name === `${prefix}.exe`;
        return asset.name === `${prefix}.tgz` || asset.name === `${prefix}.tar.gz`;
    });
    if (preferred !== undefined) return preferred;
    const archive = candidates.find(
        (asset) => asset.name.endsWith(".tgz") || asset.name.endsWith(".tar.gz"),
    );
    if (archive !== undefined) return archive;
    throw new Error(
        `cloudflared release ${release.tag_name} has no asset for ${platform}/${arch}.`,
    );
}

function selectFrpAsset(
    release: GithubRelease,
    platform: NodeJS.Platform,
    arch: NodeJS.Architecture,
): ReleaseAsset {
    const target = platformArch(platform, arch);
    const version = release.tag_name.replace(/^v/u, "");
    const expected = `frp_${version}_${target.os}_${target.arch}.tar.gz`;
    const asset = release.assets.find((candidate) => candidate.name === expected);
    if (asset !== undefined) return asset;
    throw new Error(
        `FRP release ${release.tag_name} has no asset for ${platform}/${arch}.`,
    );
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
