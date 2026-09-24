import type { ExtensionManagedProcess } from "@portable-devshell/extension";

import { AccessBinaryManager } from "../binary/AccessBinaryManager.js";
import type { CloudflaredAccessEndpoint } from "../Config.js";
import type {
    AccessProvider,
    AccessProviderContext,
    AccessProviderOpenInput,
    AccessProviderSession,
} from "./AccessProvider.js";

const remoteConfigMessage = "Updated to new configuration";
const readyMessage = "Registered tunnel connection";
const readyTimeoutMs = 30_000;

export class CloudflaredProvider implements AccessProvider {
    readonly kind = "cloudflared" as const;
    readonly #binaries: AccessBinaryManager;
    readonly #context: AccessProviderContext;

    constructor(context: AccessProviderContext, binaries: AccessBinaryManager) {
        this.#binaries = binaries;
        this.#context = context;
    }

    async open(input: AccessProviderOpenInput): Promise<AccessProviderSession> {
        if (input.endpoint.provider !== this.kind)
            throw new TypeError("CloudflaredProvider received a non-cloudflared endpoint.");
        const endpoint: CloudflaredAccessEndpoint = input.endpoint;
        const command = await this.#binaries.resolve(this.kind, endpoint.binary);
        const detector = new CloudflaredHostnameDetector(input.target.origin);
        let publicUrl = endpoint.publicUrl;
        const publicUrlListeners = new Set<(publicUrl: string) => void>();
        const process = await this.#context.processes.start({
            args: ["tunnel", "--no-autoupdate", "run", ...(endpoint.arguments ?? [])],
            command,
            environment: { TUNNEL_TOKEN: endpoint.token },
        });
        let recentOutput = "";
        let resolveReady!: () => void;
        let rejectReady!: (error: Error) => void;
        let readySettled = false;
        const ready = new Promise<void>((resolve, reject) => {
            resolveReady = () => {
                if (readySettled) return;
                readySettled = true;
                resolve();
            };
            rejectReady = (error) => {
                if (readySettled) return;
                readySettled = true;
                reject(error);
            };
        });
        const accept = (chunk: string) => {
            recentOutput = `${recentOutput}${chunk}`.slice(-16 * 1024);
            if (recentOutput.includes(readyMessage)) resolveReady();
            const detected = detector.accept(chunk);
            if (
                detected !== undefined &&
                endpoint.publicUrl === undefined &&
                detected !== publicUrl
            ) {
                publicUrl = detected;
                for (const listener of [...publicUrlListeners]) listener(detected);
            }
        };
        const removeStdout = process.onStdout(accept);
        const removeStderr = process.onStderr(accept);
        const timer = setTimeout(() => {
            rejectReady(
                new Error(
                    `cloudflared did not register a tunnel connection within ${readyTimeoutMs}ms${recentOutput.trim().length === 0 ? "" : `: ${recentOutput.trim()}`}.`,
                ),
            );
        }, readyTimeoutMs);
        void process.closed.then((exit) => {
            rejectReady(
                new Error(
                    `cloudflared exited before registering a tunnel connection (${formatExit(exit)})${recentOutput.trim().length === 0 ? "" : `: ${recentOutput.trim()}`}.`,
                ),
            );
        });
        try {
            await ready;
        } catch (error) {
            removeStdout();
            removeStderr();
            publicUrlListeners.clear();
            await process.terminate().catch(() => undefined);
            throw error;
        } finally {
            clearTimeout(timer);
        }
        return session(
            process,
            () => publicUrl,
            (listener) => {
                publicUrlListeners.add(listener);
                return () => publicUrlListeners.delete(listener);
            },
            () => {
                publicUrlListeners.clear();
                removeStdout();
                removeStderr();
            },
        );
    }
}

export class CloudflaredHostnameDetector {
    readonly #targetOrigin: URL;
    #buffer = "";

    constructor(targetOrigin: URL) {
        this.#targetOrigin = targetOrigin;
    }

    accept(chunk: string): string | undefined {
        this.#buffer += chunk;
        const lines = this.#buffer.split(/\r?\n/u);
        this.#buffer = lines.pop() ?? "";
        for (const line of lines) {
            const detected = detectCloudflaredPublicUrl(line, this.#targetOrigin);
            if (detected !== undefined) return detected;
        }
        if (this.#buffer.length > 64 * 1024)
            this.#buffer = this.#buffer.slice(-64 * 1024);
        return detectCloudflaredPublicUrl(this.#buffer, this.#targetOrigin);
    }
}

export function detectCloudflaredPublicUrl(
    line: string,
    targetOrigin: URL,
): string | undefined {
    if (!line.includes(remoteConfigMessage)) return undefined;
    const config = readRemoteConfig(line);
    if (config === undefined || !Array.isArray(config.ingress)) return undefined;
    const hostnames = new Set<string>();
    for (const rule of config.ingress) {
        if (!isRecord(rule) || typeof rule.hostname !== "string") continue;
        if (typeof rule.service !== "string") continue;
        if (!serviceMatchesOrigin(rule.service, targetOrigin)) continue;
        const hostname = normalizeHostname(rule.hostname);
        if (hostname !== undefined) hostnames.add(hostname);
    }
    if (hostnames.size !== 1) return undefined;
    return new URL(`https://${[...hostnames][0]!}/`).href;
}

function readRemoteConfig(line: string): Record<string, unknown> | undefined {
    try {
        const structured = JSON.parse(line) as unknown;
        if (
            isRecord(structured) &&
            structured.message === remoteConfigMessage &&
            typeof structured.config === "string"
        ) {
            const parsed = JSON.parse(structured.config) as unknown;
            return isRecord(parsed) ? parsed : undefined;
        }
    } catch {
        // Console-formatted cloudflared logs are handled below.
    }

    const marker = "config=";
    const offset = line.indexOf(marker);
    if (offset === -1) return undefined;
    const source = line.slice(offset + marker.length).trimStart();
    const encoded = readEncodedConfig(source);
    if (encoded === undefined) return undefined;
    try {
        const parsed = JSON.parse(encoded) as unknown;
        return isRecord(parsed) ? parsed : undefined;
    } catch {
        return undefined;
    }
}

function readEncodedConfig(source: string): string | undefined {
    if (source.startsWith('"')) {
        let escaped = false;
        for (let index = 1; index < source.length; index += 1) {
            const char = source[index]!;
            if (escaped) {
                escaped = false;
                continue;
            }
            if (char === "\\") {
                escaped = true;
                continue;
            }
            if (char !== '"') continue;
            try {
                const decoded = JSON.parse(source.slice(0, index + 1)) as unknown;
                return typeof decoded === "string" ? decoded : undefined;
            } catch {
                return undefined;
            }
        }
        return undefined;
    }
    if (!source.startsWith("{")) return undefined;
    const version = source.lastIndexOf(" version=");
    return version === -1 ? source : source.slice(0, version);
}

function serviceMatchesOrigin(service: string, targetOrigin: URL): boolean {
    let candidate: URL;
    try {
        candidate = new URL(service);
    } catch {
        return false;
    }
    if (candidate.protocol !== targetOrigin.protocol) return false;
    if (normalizedPort(candidate) !== normalizedPort(targetOrigin)) return false;
    return sameHost(candidate.hostname, targetOrigin.hostname);
}

function normalizedPort(url: URL): string {
    if (url.port.length > 0) return url.port;
    return url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : "";
}

function sameHost(left: string, right: string): boolean {
    if (left === right) return true;
    return isLoopback(left) && isLoopback(right);
}

function isLoopback(host: string): boolean {
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function normalizeHostname(value: string): string | undefined {
    const hostname = value.trim().toLowerCase();
    if (hostname.length === 0 || hostname.includes("*")) return undefined;
    try {
        return new URL(`https://${hostname}/`).hostname;
    } catch {
        return undefined;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatExit(exit: { readonly code?: number; readonly signal?: string }): string {
    if (exit.code !== undefined) return `code ${exit.code}`;
    if (exit.signal !== undefined) return `signal ${exit.signal}`;
    return "unknown exit";
}

function session(
    process: ExtensionManagedProcess,
    publicUrl: () => string | undefined,
    onPublicUrlChange: (
        listener: (publicUrl: string) => void,
    ) => () => void,
    cleanup: () => void,
): AccessProviderSession {
    let cleaned = false;
    const release = () => {
        if (cleaned) return;
        cleaned = true;
        cleanup();
    };
    void process.closed.finally(release);
    return Object.freeze({
        closed: process.closed.then(() => undefined),
        onPublicUrlChange,
        process,
        publicUrl,
        stop: async () => {
            try {
                await process.terminate();
                await process.closed;
            } finally {
                release();
            }
        },
    });
}
