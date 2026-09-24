import type {
    ExtensionConfig,
    ExtensionContext,
    ExtensionJsonValue,
} from "@portable-devshell/extension";

import { AccessBinaryManager } from "./binary/AccessBinaryManager.js";
import {
    endpointToJson,
    parseAccessConfig,
    type AccessEndpoint,
    type AccessProviderKind,
    type AccessTargetKind,
} from "./Config.js";
import { resolveAccessTarget } from "./Target.js";
import type {
    AccessProvider,
    AccessProviderSession,
} from "./provider/AccessProvider.js";
import { CloudflaredProvider } from "./provider/CloudflaredProvider.js";
import { FrpProvider } from "./provider/FrpProvider.js";
import { SshReverseProvider } from "./provider/SshReverseProvider.js";
import { AccessWebServer } from "./AccessWeb.js";

export type AccessEndpointState =
    | "disabled"
    | "error"
    | "running"
    | "starting"
    | "waiting";

export interface AccessEndpointRecord {
    readonly enabled: boolean;
    readonly error?: string;
    readonly id: string;
    readonly origin?: string;
    readonly provider: AccessProviderKind;
    readonly publicUrl?: string;
    readonly state: AccessEndpointState;
    readonly target: AccessTargetKind;
}

interface ActiveEndpoint {
    fingerprint: string;
    publishedPublicUrl?: string;
    record: AccessEndpointRecord;
    restartAttempt: number;
    session?: AccessProviderSession;
    token: object;
    unsubscribePublicUrl?: () => void;
}

export interface AccessRuntimeOptions {
    providers?: readonly AccessProvider[];
    reconcileDelayMs?: number;
}

export class AccessRuntime {
    readonly #config: ExtensionConfig;
    readonly #context: ExtensionContext;
    readonly #providers: ReadonlyMap<AccessProviderKind, AccessProvider>;
    readonly #records = new Map<string, ActiveEndpoint>();
    readonly #reconcileDelayMs: number;
    readonly #unsubscribeConfig: () => void;
    #disposed = false;
    #reconcileDeadline?: number;
    #reconcilePromise: Promise<void> = Promise.resolve();
    #reconcileTimer?: NodeJS.Timeout;
    #web?: AccessWebServer;

    constructor(context: ExtensionContext, options: AccessRuntimeOptions = {}) {
        const config = context.config;
        if (config === undefined)
            throw new Error("Access Extension requires declared Config access.");
        const processes = context.capabilities.processes;
        if (processes === undefined)
            throw new Error("Access Extension requires the processes capability.");
        this.#config = config;
        this.#context = context;
        this.#reconcileDelayMs = options.reconcileDelayMs ?? 100;
        const binaries = new AccessBinaryManager(context.paths.dataDirectory, {
            processes,
        });
        const providerContext = {
            dataDirectory: context.paths.dataDirectory,
            processes,
            runtimeDirectory: context.paths.runtimeDirectory,
        };
        const providers =
            options.providers ??
            [
                new CloudflaredProvider(providerContext, binaries),
                new FrpProvider(providerContext, binaries),
                new SshReverseProvider(providerContext, binaries),
            ];
        const mapped = new Map<AccessProviderKind, AccessProvider>();
        for (const provider of providers) {
            if (mapped.has(provider.kind))
                throw new TypeError(`Duplicate Access provider: ${provider.kind}.`);
            mapped.set(provider.kind, provider);
        }
        this.#providers = mapped;
        this.#unsubscribeConfig = config.onChange((change) => {
            if (
                change.paths.some(
                    (path) =>
                        path.startsWith("access.") ||
                        path.startsWith("mcp.") ||
                        path.startsWith("web."),
                )
            ) {
                this.#scheduleReconcile(0);
            }
        });
        this.#scheduleReconcile(this.#reconcileDelayMs);
    }

    list(): AccessEndpointRecord[] {
        return [...this.#records.values()]
            .map((active) => this.#record(active))
            .sort((left, right) => left.id.localeCompare(right.id));
    }

    get(id: string): AccessEndpointRecord | undefined {
        const active = this.#records.get(id);
        return active === undefined ? undefined : this.#record(active);
    }

    async reload(): Promise<void> {
        this.#assertOpen();
        for (const active of this.#records.values()) {
            active.fingerprint = "";
            active.restartAttempt = 0;
        }
        await this.reconcile();
    }

    async upsert(value: ExtensionJsonValue): Promise<AccessEndpointRecord> {
        this.#assertOpen();
        const endpoint = parseAccessConfig({ endpoints: [value] }).endpoints[0]!;
        const endpoints = [...(await this.#readConfig()).endpoints];
        const index = endpoints.findIndex((candidate) => candidate.id === endpoint.id);
        if (index === -1) endpoints.push(endpoint);
        else endpoints[index] = endpoint;
        await this.#writeEndpoints(endpoints);
        await this.reconcile();
        return this.get(endpoint.id) ?? this.#initialRecord(endpoint);
    }

    async remove(id: string): Promise<{ id: string; removed: true }> {
        this.#assertOpen();
        const endpoints = [...(await this.#readConfig()).endpoints];
        const next = endpoints.filter((endpoint) => endpoint.id !== id);
        if (next.length === endpoints.length)
            throw new Error(`Access endpoint not found: ${id}.`);
        await this.#writeEndpoints(next);
        await this.reconcile();
        return { id, removed: true };
    }

    async setEnabled(id: string, enabled: boolean): Promise<AccessEndpointRecord> {
        this.#assertOpen();
        const endpoints = [...(await this.#readConfig()).endpoints];
        const index = endpoints.findIndex((endpoint) => endpoint.id === id);
        if (index === -1) throw new Error(`Access endpoint not found: ${id}.`);
        endpoints[index] = Object.freeze({ ...endpoints[index]!, enabled }) as AccessEndpoint;
        await this.#writeEndpoints(endpoints);
        await this.reconcile();
        return this.get(id) ?? this.#initialRecord(endpoints[index]!);
    }

    async setPublicUrl(id: string, publicUrl: string): Promise<AccessEndpointRecord> {
        this.#assertOpen();
        const endpoints = [...(await this.#readConfig()).endpoints];
        const index = endpoints.findIndex((endpoint) => endpoint.id === id);
        if (index === -1) throw new Error(`Access endpoint not found: ${id}.`);
        const endpoint = parseAccessConfig({
            endpoints: [
                endpointToJson({ ...endpoints[index]!, publicUrl } as AccessEndpoint),
            ],
        }).endpoints[0]!;
        endpoints[index] = endpoint;
        await this.#writeEndpoints(endpoints);
        await this.reconcile();
        return this.get(id) ?? this.#initialRecord(endpoint);
    }

    async reconcile(): Promise<void> {
        this.#assertOpen();
        if (this.#reconcileTimer !== undefined) {
            clearTimeout(this.#reconcileTimer);
            this.#reconcileTimer = undefined;
            this.#reconcileDeadline = undefined;
        }
        const operation = this.#reconcilePromise.then(
            async () => await this.#reconcileOnce(),
            async () => await this.#reconcileOnce(),
        );
        this.#reconcilePromise = operation.catch((error: unknown) => {
            this.#context.logger.error("Access reconcile failed.", {
                error: toError(error).message,
            });
        });
        await operation;
    }

    async webUpstream(): Promise<URL> {
        this.#assertOpen();
        this.#web ??= new AccessWebServer(this);
        return await this.#web.start();
    }

    async dispose(): Promise<void> {
        if (this.#disposed) return;
        this.#disposed = true;
        this.#unsubscribeConfig();
        if (this.#reconcileTimer !== undefined) clearTimeout(this.#reconcileTimer);
        this.#reconcileTimer = undefined;
        this.#reconcileDeadline = undefined;
        await this.#reconcilePromise.catch(() => undefined);
        const failures: unknown[] = [];
        await Promise.all(
            [...this.#records.values()].map(async (active) => {
                active.token = {};
                await active.session?.stop().catch((error) => failures.push(error));
                active.session = undefined;
            }),
        );
        await this.#web?.close().catch((error) => failures.push(error));
        this.#web = undefined;
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1)
            throw new AggregateError(failures, "Access Extension cleanup was incomplete.");
    }

    async #reconcileOnce(): Promise<void> {
        if (this.#disposed) return;
        const config = await this.#readConfig();
        const desired = new Map(config.endpoints.map((endpoint) => [endpoint.id, endpoint]));
        for (const [id, active] of [...this.#records]) {
            if (desired.has(id)) continue;
            const stopFailure = await this.#stopActive(active);
            if (stopFailure !== undefined) {
                active.fingerprint = "";
                active.record = {
                    ...active.record,
                    enabled: false,
                    error: `Failed to stop removed tunnel: ${stopFailure.message}`,
                    state: "error",
                };
                this.#scheduleRetry(active);
                continue;
            }
            this.#records.delete(id);
        }
        for (const endpoint of config.endpoints) await this.#reconcileEndpoint(endpoint);
    }

    async #reconcileEndpoint(endpoint: AccessEndpoint): Promise<void> {
        let active = this.#records.get(endpoint.id);
        if (active === undefined) {
            active = {
                fingerprint: "",
                record: this.#initialRecord(endpoint),
                restartAttempt: 0,
                token: {},
            };
            this.#records.set(endpoint.id, active);
        }
        if (!endpoint.enabled) {
            const stopFailure = await this.#stopActive(active);
            if (stopFailure !== undefined) {
                this.#recordStopFailure(active, endpoint, stopFailure);
                return;
            }
            active.fingerprint = fingerprint(endpoint, "disabled");
            active.restartAttempt = 0;
            active.record = this.#initialRecord(endpoint);
            return;
        }

        let resolved;
        try {
            resolved = await resolveAccessTarget(this.#config, endpoint.target);
        } catch (error) {
            const stopFailure = await this.#stopActive(active);
            if (stopFailure !== undefined) {
                this.#recordStopFailure(active, endpoint, stopFailure);
                return;
            }
            active.fingerprint = "";
            active.record = {
                ...this.#initialRecord(endpoint),
                error: toError(error).message,
                state: "error",
            };
            this.#scheduleRetry(active);
            return;
        }
        if (!resolved.available) {
            const stopFailure = await this.#stopActive(active);
            if (stopFailure !== undefined) {
                this.#recordStopFailure(active, endpoint, stopFailure);
                return;
            }
            active.fingerprint = fingerprint(endpoint, resolved.reason);
            active.restartAttempt = 0;
            active.record = {
                ...this.#initialRecord(endpoint),
                error: resolved.reason,
                state: "waiting",
            };
            return;
        }
        const nextFingerprint = fingerprint(endpoint, resolved.target.origin.href);
        if (
            active.session !== undefined &&
            active.fingerprint === nextFingerprint
        ) {
            active.record = {
                ...active.record,
                origin: resolved.target.origin.href,
                ...(active.session.publicUrl() === undefined
                    ? {}
                    : { publicUrl: active.session.publicUrl() }),
                state: "running",
            };
            return;
        }
        const stopFailure = await this.#stopActive(active);
        if (stopFailure !== undefined) {
            this.#recordStopFailure(active, endpoint, stopFailure);
            return;
        }
        active.fingerprint = nextFingerprint;
        active.record = {
            ...this.#initialRecord(endpoint),
            origin: resolved.target.origin.href,
            state: "starting",
        };
        const token = {};
        active.token = token;
        try {
            const provider = this.#providers.get(endpoint.provider);
            if (provider === undefined)
                throw new Error(`Access provider is unavailable: ${endpoint.provider}.`);
            const session = await provider.open({
                endpoint,
                target: resolved.target,
            });
            if (this.#disposed || active.token !== token) {
                await session.stop();
                return;
            }
            active.session = session;
            active.unsubscribePublicUrl = session.onPublicUrlChange?.((publicUrl) => {
                void this.#publishPublicUrl(endpoint, active!, token, publicUrl).catch(
                    (error: unknown) =>
                        this.#context.logger.warn("Failed to publish Access public URL.", {
                            endpoint: endpoint.id,
                            error: toError(error).message,
                        }),
                );
            });
            active.restartAttempt = 0;
            active.record = {
                ...this.#initialRecord(endpoint),
                origin: resolved.target.origin.href,
                ...(session.publicUrl() === undefined
                    ? {}
                    : { publicUrl: session.publicUrl() }),
                state: "running",
            };
            const initialPublicUrl = session.publicUrl();
            if (initialPublicUrl !== undefined)
                await this.#publishPublicUrl(
                    endpoint,
                    active,
                    token,
                    initialPublicUrl,
                );
            void session.closed.then(() => this.#sessionClosed(endpoint.id, token));
        } catch (error) {
            if (active.token !== token || this.#disposed) return;
            active.session = undefined;
            active.record = {
                ...this.#initialRecord(endpoint),
                error: toError(error).message,
                origin: resolved.target.origin.href,
                state: "error",
            };
            this.#scheduleRetry(active);
        }
    }

    #sessionClosed(id: string, token: object): void {
        if (this.#disposed) return;
        const active = this.#records.get(id);
        if (active === undefined || active.token !== token) return;
        active.unsubscribePublicUrl?.();
        active.unsubscribePublicUrl = undefined;
        active.session = undefined;
        active.fingerprint = "";
        active.record = {
            ...active.record,
            error: "Tunnel process exited.",
            state: "error",
        };
        this.#scheduleRetry(active);
    }

    #scheduleRetry(active: ActiveEndpoint): void {
        active.restartAttempt += 1;
        const delay = Math.min(30_000, 1_000 * 2 ** Math.min(5, active.restartAttempt - 1));
        this.#scheduleReconcile(delay);
    }

    #scheduleReconcile(delay: number): void {
        if (this.#disposed) return;
        const deadline = Date.now() + Math.max(0, delay);
        if (this.#reconcileTimer !== undefined) {
            if (
                this.#reconcileDeadline !== undefined &&
                this.#reconcileDeadline <= deadline
            )
                return;
            clearTimeout(this.#reconcileTimer);
        }
        this.#reconcileDeadline = deadline;
        this.#reconcileTimer = setTimeout(() => {
            this.#reconcileTimer = undefined;
            this.#reconcileDeadline = undefined;
            void this.reconcile().catch((error: unknown) =>
                this.#context.logger.error("Access reconcile failed.", {
                    error: toError(error).message,
                }),
            );
        }, Math.max(0, deadline - Date.now()));
        this.#reconcileTimer.unref?.();
    }

    async #stopActive(active: ActiveEndpoint): Promise<Error | undefined> {
        active.token = {};
        active.unsubscribePublicUrl?.();
        active.unsubscribePublicUrl = undefined;
        const session = active.session;
        if (session === undefined) return undefined;
        try {
            await session.stop();
            active.session = undefined;
            return undefined;
        } catch (error) {
            const failure = toError(error);
            this.#context.logger.warn("Access tunnel stop failed.", {
                endpoint: active.record.id,
                error: failure.message,
            });
            return failure;
        }
    }

    #recordStopFailure(
        active: ActiveEndpoint,
        endpoint: AccessEndpoint,
        failure: Error,
    ): void {
        active.fingerprint = "";
        active.record = {
            ...this.#initialRecord(endpoint),
            error: `Failed to stop previous tunnel: ${failure.message}`,
            state: "error",
        };
        this.#scheduleRetry(active);
    }

    async #readConfig() {
        const endpoints = await this.#config.get("access.endpoints");
        return parseAccessConfig({ endpoints: endpoints ?? [] });
    }

    async #writeEndpoints(endpoints: readonly AccessEndpoint[]): Promise<void> {
        await this.#config.update({
            "access.endpoints": endpoints.map(endpointToJson),
        });
    }

    async #publishPublicUrl(
        endpoint: AccessEndpoint,
        active: ActiveEndpoint,
        token: object,
        publicUrl: string,
    ): Promise<void> {
        if (this.#disposed || active.token !== token) return;
        const path = `${endpoint.target}.publicBaseUrl`;
        const current = await this.#config.get(path);
        if (
            current !== undefined &&
            current !== active.publishedPublicUrl &&
            current !== publicUrl &&
            !isEquivalentLocalBaseUrl(current, active.record.origin)
        )
            return;
        if (current === publicUrl) {
            active.publishedPublicUrl = publicUrl;
            return;
        }
        await this.#config.update({ [path]: publicUrl });
        active.publishedPublicUrl = publicUrl;
    }

    #record(active: ActiveEndpoint): AccessEndpointRecord {
        const publicUrl = active.session?.publicUrl() ?? active.record.publicUrl;
        return Object.freeze({
            ...active.record,
            ...(publicUrl === undefined ? {} : { publicUrl }),
        });
    }

    #initialRecord(endpoint: AccessEndpoint): AccessEndpointRecord {
        return Object.freeze({
            enabled: endpoint.enabled,
            id: endpoint.id,
            provider: endpoint.provider,
            state: endpoint.enabled ? "waiting" : "disabled",
            target: endpoint.target,
        });
    }

    #assertOpen(): void {
        if (this.#disposed) throw new Error("Access Extension is disposed.");
    }
}

function fingerprint(endpoint: AccessEndpoint, target: string): string {
    return JSON.stringify([endpoint, target]);
}

function isEquivalentLocalBaseUrl(
    current: ExtensionJsonValue,
    origin: string | undefined,
): boolean {
    if (typeof current !== "string" || origin === undefined) return false;
    let left: URL;
    let right: URL;
    try {
        left = new URL(current);
        right = new URL(origin);
    } catch {
        return false;
    }
    if (
        left.protocol !== right.protocol ||
        effectivePort(left) !== effectivePort(right)
    )
        return false;
    return equivalentLocalHost(left.hostname, right.hostname);
}

function effectivePort(url: URL): string {
    if (url.port.length > 0) return url.port;
    return url.protocol === "https:"
        ? "443"
        : url.protocol === "http:"
          ? "80"
          : "";
}

function equivalentLocalHost(left: string, right: string): boolean {
    if (left === right) return true;
    const local = new Set([
        "0.0.0.0",
        "127.0.0.1",
        "::",
        "::1",
        "localhost",
    ]);
    return local.has(left) && local.has(right);
}

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
