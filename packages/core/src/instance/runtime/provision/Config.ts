import type { WorkerHandshakeParams } from "../../Api.js";
import type {
    ControlInstanceAlertsConfig,
    ControlInstanceConfig,
    EffectiveSecurityMode,
    InstanceName,
    InstanceContainerPresetSchema,
    InstanceCreateProvider,
    InstanceCreateSchema,
    InstanceCreateSummary,
    JsonValue,
} from "@portable-devshell/shared";
import {
    ConfigInputError,
    configInputError,
    controlErrorCodes,
    createRemoteError,
    defaultConfigNormalizeContext,
    formatConfigPath,
    normalizeConfigInstanceDraft,
    parseConfigInstanceDraft,
} from "@portable-devshell/shared";
import { globSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";

import type { TransportConnection } from "../../transport/endpoint/Connection.js";
import type { WorkerRuntime } from "../execution/Command.js";
import { WORKER_PROTOCOL_RANGE } from "../../transport/packet/Client.js";

export type WorkerManagementMode = "controllerManaged" | "selfManaged";

export const WORKER_GENERATION_RETENTION_DAYS = 7;
export const WORKER_GENERATION_RETENTION_MS =
    WORKER_GENERATION_RETENTION_DAYS * 24 * 60 * 60 * 1_000;

export interface WorkerInstanceConfigCommon {
    alerts?: ControlInstanceAlertsConfig;
    effectiveSecurityMode?: EffectiveSecurityMode;
    name: InstanceName;
    homeDirectory?: string;
    env?: NodeJS.ProcessEnv;
    handshake?: Partial<WorkerHandshakeParams>;
}

export type WorkerInstanceConfig =
    | (WorkerInstanceConfigCommon & {
          managementMode?: "controllerManaged";
          runtime: WorkerRuntime;
          transportConnection: TransportConnection;
      })
    | (WorkerInstanceConfigCommon & {
          managementMode: "selfManaged";
          runtime?: never;
          transportConnection: TransportConnection;
      });

export interface ResolvedWorkerInstanceConfig extends WorkerInstanceConfigCommon {
    effectiveSecurityMode: EffectiveSecurityMode;
    handshake: WorkerHandshakeParams;
    managementMode: WorkerManagementMode;
    runtime?: WorkerRuntime;
    transportConnection: TransportConnection;
}

export function resolveWorkerInstanceConfig(
    config: WorkerInstanceConfig,
): ResolvedWorkerInstanceConfig {
    const managementMode = config.managementMode ?? "controllerManaged";

    return {
        ...config,
        effectiveSecurityMode: config.effectiveSecurityMode ?? "disabled",
        handshake: {
            protocolRange: WORKER_PROTOCOL_RANGE,
            clientName: "portable-devshell",
            clientVersion: "0.0.0",
            ...config.handshake,
        },
        managementMode,
    };
}

const unixProviders = [
    "local",
    "ssh",
    "docker",
    "podman",
    "reverse",
] as const satisfies readonly InstanceCreateProvider[];
const windowsProviders = [
    "local",
    "ssh",
    "reverse",
] as const satisfies readonly InstanceCreateProvider[];

const containerPresets =
    defaultConfigNormalizeContext.containerPresets satisfies readonly InstanceContainerPresetSchema[];

export function listInstanceCreateProviders(
    platform = process.platform,
): readonly InstanceCreateProvider[] {
    return platform === "win32" ? windowsProviders : unixProviders;
}

export function resolveInstanceCreateSchema(options: {
    hasLocal: boolean;
    platform?: NodeJS.Platform;
    sshHosts?: readonly string[];
}): InstanceCreateSchema {
    const providers = listInstanceCreateProviders(
        options.platform ?? process.platform,
    );
    return {
        container: {
            defaultMode: "preset",
            modes: [
                "preset",
                "dockerfile",
                "compose",
                "existingImage",
                "existingStoppedContainer",
            ],
            presets: containerPresets,
        },
        defaultMcpContextMode: "openai-session",
        defaultModelExtensions:
            defaultConfigNormalizeContext.defaultModelExtensions,
        defaultEnabled: defaultConfigNormalizeContext.defaultEnabled,
        defaultMcpEnabled: defaultConfigNormalizeContext.defaultMcpEnabled,
        defaultProvider:
            options.hasLocal && providers.includes("ssh") ? "ssh" : "local",
        defaultSecurityMode: defaultConfigNormalizeContext.defaultSecurityMode,
        providers,
        sshHosts: options.sshHosts ?? [],
    };
}

export function normalizeInstanceCreateDraft(
    params: JsonValue | undefined,
    platform = process.platform,
): ControlInstanceConfig {
    try {
        const draft = parseConfigInstanceDraft(params);
        if (!listInstanceCreateProviders(platform).includes(draft.provider)) {
            throw configInputError(
                "semantic",
                ["provider"],
                "config.instance.providerUnsupported",
                `is not supported on ${platform}`,
            );
        }
        const createDraft =
            draft.mcp?.auth === undefined
                ? {
                      ...draft,
                      mcp: {
                          ...draft.mcp,
                          auth: "oauth2" as const,
                          oauth2: {
                              requiredScopes: ["mcp"],
                              resourceName: draft.name,
                          },
                      },
                  }
                : draft;
        return normalizeConfigInstanceDraft(createDraft);
    } catch (error) {
        if (!(error instanceof ConfigInputError)) throw error;
        throw createRemoteError({
            code: controlErrorCodes.configInvalid,
            cause: error,
            details: {
                fieldPath: formatConfigPath(error.issue.path),
                issueCode: error.issue.code,
                phase: error.issue.phase,
            },
            message: error.message,
            retryable: false,
        });
    }
}

export function summarizeInstanceCreate(
    instance: ControlInstanceConfig,
): InstanceCreateSummary {
    return {
        ...(instance.approvalPolicy === undefined
            ? {}
            : { approvalPolicy: structuredClone(instance.approvalPolicy) }),
        ...(instance.container === undefined
            ? {}
            : { container: redactContainerSecrets(instance.container) }),
        ...(instance.dockerBinary === undefined
            ? {}
            : { dockerBinary: instance.dockerBinary }),
        ...(instance.env === undefined
            ? {}
            : { env: redactSecretRecord(instance.env) }),
        extensions: { model: [...instance.extensions.model] },
        ...(instance.logs === undefined ? {} : { logs: { ...instance.logs } }),
        ...(instance.podmanBinary === undefined
            ? {}
            : { podmanBinary: instance.podmanBinary }),
        enabled: instance.enabled,
        mcp: {
            auth: {
                mode: instance.mcp.auth.mode,
                ...(instance.mcp.auth.mode === "oauth2"
                    ? { oauth2: structuredClone(instance.mcp.auth.oauth2) }
                    : {}),
            },
            contextMode: instance.mcp.contextMode,
            enabled: instance.mcp.enabled,
            path: instance.mcp.path,
        },
        name: instance.name,
        provider: instance.provider,
        security: { mode: instance.security.mode },
        ...(instance.ssh === undefined ? {} : { ssh: { ...instance.ssh } }),
        ...(instance.tools === undefined
            ? {}
            : { tools: structuredClone(instance.tools) }),
    };
}

function redactContainerSecrets(
    container: ControlInstanceConfig["container"],
): NonNullable<ControlInstanceConfig["container"]> {
    const copy = structuredClone(container!);
    if ("env" in copy && copy.env !== undefined)
        copy.env = redactSecretRecord(copy.env);
    return copy;
}

function redactSecretRecord(
    record: Record<string, string>,
): Record<string, string> {
    return Object.fromEntries(
        Object.keys(record).map((key) => [key, "********"]),
    );
}

export function discoverSshConfigHosts(
    entryPath = resolve(homedir(), ".ssh", "config"),
): readonly string[] {
    const hosts = new Set<string>();
    const visited = new Set<string>();
    readSshConfig(entryPath, hosts, visited);
    return [...hosts].sort((left, right) => left.localeCompare(right));
}

function readSshConfig(
    path: string,
    hosts: Set<string>,
    visited: Set<string>,
): void {
    const normalized = resolve(path);
    if (visited.has(normalized)) return;
    visited.add(normalized);
    let source: string;
    try {
        source = readFileSync(normalized, "utf8");
    } catch {
        return;
    }
    for (const rawLine of source.split(/\r?\n/u)) {
        const line = stripSshComment(rawLine).trim();
        if (line.length === 0) continue;
        const match = /^(\S+)\s+(.+)$/u.exec(line);
        if (match === null) continue;
        const keyword = match[1]!.toLowerCase();
        const value = match[2]!.trim();
        if (keyword === "host") {
            for (const host of splitSshWords(value)) {
                if (
                    host.length > 0 &&
                    !host.startsWith("!") &&
                    !host.includes("*") &&
                    !host.includes("?")
                ) hosts.add(host);
            }
            continue;
        }
        if (keyword !== "include") continue;
        for (const include of splitSshWords(value)) {
            const expanded = include.startsWith("~/")
                ? resolve(homedir(), include.slice(2))
                : isAbsolute(include)
                  ? include
                  : resolve(dirname(normalized), include);
            let includedPaths: string[];
            try {
                includedPaths = globSync(expanded);
            } catch {
                continue;
            }
            for (const includedPath of includedPaths)
                readSshConfig(includedPath, hosts, visited);
        }
    }
}

function stripSshComment(line: string): string {
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        if (char === '"') quoted = !quoted;
        if (char === "#" && !quoted) return line.slice(0, index);
    }
    return line;
}

function splitSshWords(value: string): string[] {
    return value
        .split(/\s+/u)
        .map((entry) => entry.replace(/^"|"$/gu, ""))
        .filter((entry) => entry.length > 0);
}
