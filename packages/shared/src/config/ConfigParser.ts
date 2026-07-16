import type {
    ApprovalPolicy,
    ApprovalPolicyDecision,
    ApprovalPolicyMode,
    ApprovalPolicySourceScope
} from "../dto/tool/DtoToolApproval.js";
import type { ToolCapability } from "../dto/tool/DtoToolDefinition.js";
import { configInputError, type ConfigPathSegment } from "./ConfigIssue.js";
import type {
    ConfigContainerDraft,
    ConfigDraft,
    ConfigGlobalDraft,
    ConfigInstanceDraft,
    ConfigInstancePatch,
    ConfigInstanceTargetRequest,
    ConfigMcpAuthDraft,
    ConfigMcpPatch,
    ConfigPatch,
    ConfigUpdateInstanceRequest,
    ConfigUpdateMcpRequest,
    ControlInstanceLogsConfig,
    ControlInstanceToolsConfig,
    ControlProviderKind,
    ControlSecurityMode,
    ControlToolSchedulerConfig
} from "./ConfigModel.js";

const instanceKeys = [
    "approvalPolicy",
    "container",
    "dockerBinary",
    "enabled",
    "env",
    "logs",
    "mcp",
    "name",
    "podmanBinary",
    "provider",
    "security",
    "ssh",
    "tools",
    "workspace"
] as const;

const instancePatchKeys = instanceKeys.filter((key) => key !== "name");

export function parseConfigDraft(value: unknown): ConfigDraft {
    const record = readRecord(value, []);
    assertKnownKeys(record, ["control", "instances", "mcp"], []);

    return {
        control: record.control === undefined ? undefined : parseControlDraft(record.control, ["control"]),
        instances:
            record.instances === undefined
                ? undefined
                : readArray(record.instances, ["instances"]).map((entry, index) =>
                      parseConfigInstanceDraft(entry, ["instances", index])
                  ),
        mcp: record.mcp === undefined ? undefined : parseGlobalMcpDraft(record.mcp, ["mcp"])
    };
}

export function parseConfigGlobalDraft(value: unknown): ConfigGlobalDraft {
    const record = readRecord(value, []);
    assertKnownKeys(record, ["control", "mcp"], []);

    return {
        control: record.control === undefined ? undefined : parseControlDraft(record.control, ["control"]),
        mcp: record.mcp === undefined ? undefined : parseGlobalMcpDraft(record.mcp, ["mcp"])
    };
}

export function parseConfigInstanceDraft(
    value: unknown,
    path: readonly ConfigPathSegment[] = []
): ConfigInstanceDraft {
    const record = readRecord(value, path);
    assertKnownKeys(record, instanceKeys, path);

    return {
        approvalPolicy:
            record.approvalPolicy === undefined
                ? undefined
                : parseApprovalPolicy(record.approvalPolicy, [...path, "approvalPolicy"]),
        container:
            record.container === undefined
                ? undefined
                : parseContainerDraft(record.container, [...path, "container"]),
        dockerBinary: readOptionalTrimmedString(record.dockerBinary, [...path, "dockerBinary"]),
        enabled: readOptionalBoolean(record.enabled, [...path, "enabled"]),
        env: readOptionalStringRecord(record.env, [...path, "env"]),
        logs: record.logs === undefined ? undefined : parseLogs(record.logs, [...path, "logs"]),
        mcp: record.mcp === undefined ? undefined : parseInstanceMcpDraft(record.mcp, [...path, "mcp"]),
        name: readRequiredTrimmedString(record.name, [...path, "name"]),
        podmanBinary: readOptionalTrimmedString(record.podmanBinary, [...path, "podmanBinary"]),
        provider: readEnum(record.provider, [...path, "provider"], ["local", "ssh", "docker", "podman", "reverse"]),
        security:
            record.security === undefined
                ? undefined
                : parseSecurityDraft(record.security, [...path, "security"]),
        ssh: record.ssh === undefined ? undefined : parseSshDraft(record.ssh, [...path, "ssh"]),
        tools: record.tools === undefined ? undefined : parseTools(record.tools, [...path, "tools"]),
        workspace: readOptionalTrimmedString(record.workspace, [...path, "workspace"])
    };
}

export function parseConfigPatch(value: unknown): ConfigPatch {
    const record = readRecord(value, []);
    assertKnownKeys(record, ["control", "mcp"], []);

    return {
        control: record.control === undefined ? undefined : parseControlDraft(record.control, ["control"]),
        mcp: record.mcp === undefined ? undefined : parseConfigMcpPatch(record.mcp, ["mcp"])
    };
}

export function parseConfigInstancePatch(
    value: unknown,
    path: readonly ConfigPathSegment[] = []
): ConfigInstancePatch {
    const record = readRecord(value, path);
    assertKnownKeys(record, instancePatchKeys, path);

    return {
        approvalPolicy: readNullable(
            record.approvalPolicy,
            (entry) => parseApprovalPolicy(entry, [...path, "approvalPolicy"])
        ),
        container: readNullable(record.container, (entry) => parseContainerDraft(entry, [...path, "container"])),
        dockerBinary: readNullable(record.dockerBinary, (entry) =>
            readRequiredTrimmedString(entry, [...path, "dockerBinary"])
        ),
        enabled: readOptionalBoolean(record.enabled, [...path, "enabled"]),
        env: readNullable(record.env, (entry) => readStringRecord(entry, [...path, "env"])),
        logs: readNullable(record.logs, (entry) => parseLogs(entry, [...path, "logs"])),
        mcp: record.mcp === undefined ? undefined : parseInstanceMcpPatch(record.mcp, [...path, "mcp"]),
        podmanBinary: readNullable(record.podmanBinary, (entry) =>
            readRequiredTrimmedString(entry, [...path, "podmanBinary"])
        ),
        provider:
            record.provider === undefined
                ? undefined
                : readEnum<ControlProviderKind>(record.provider, [...path, "provider"], [
                      "local",
                      "ssh",
                      "docker",
                      "podman",
                      "reverse"
                  ]),
        security:
            record.security === undefined
                ? undefined
                : parseSecurityDraft(record.security, [...path, "security"]),
        ssh: readNullable(record.ssh, (entry) => parseSshDraft(entry, [...path, "ssh"])),
        tools: readNullable(record.tools, (entry) => parseTools(entry, [...path, "tools"])),
        workspace: readOptionalTrimmedString(record.workspace, [...path, "workspace"])
    };
}

export function parseConfigMcpPatch(
    value: unknown,
    path: readonly ConfigPathSegment[] = []
): ConfigMcpPatch {
    const record = readRecord(value, path);
    assertKnownKeys(record, ["auth", "enabled", "listenHost", "listenPort", "publicBaseUrl"], path);

    return {
        auth: record.auth === undefined ? undefined : parseMcpAuthDraft(record.auth, [...path, "auth"]),
        enabled: readOptionalBoolean(record.enabled, [...path, "enabled"]),
        listenHost: readOptionalTrimmedString(record.listenHost, [...path, "listenHost"]),
        listenPort: readOptionalInteger(record.listenPort, [...path, "listenPort"]),
        publicBaseUrl: readNullable(record.publicBaseUrl, (entry) =>
            readRequiredTrimmedString(entry, [...path, "publicBaseUrl"])
        )
    };
}

export function parseConfigUpdateInstanceRequest(value: unknown): ConfigUpdateInstanceRequest {
    const record = readRecord(value, []);
    assertKnownKeys(record, ["instanceName", "patch"], []);
    return {
        instanceName: readRequiredTrimmedString(record.instanceName, ["instanceName"]),
        patch: parseConfigInstancePatch(record.patch, ["patch"])
    };
}

export function parseConfigUpdateMcpRequest(value: unknown): ConfigUpdateMcpRequest {
    const record = readRecord(value, []);
    assertKnownKeys(record, ["patch"], []);
    return {
        patch: parseConfigMcpPatch(record.patch, ["patch"])
    };
}

export function parseConfigInstanceTargetRequest(value: unknown): ConfigInstanceTargetRequest {
    const record = readRecord(value, []);
    assertKnownKeys(record, ["instanceName"], []);
    return {
        instanceName: readRequiredTrimmedString(record.instanceName, ["instanceName"])
    };
}

function parseControlDraft(value: unknown, path: readonly ConfigPathSegment[]): NonNullable<ConfigGlobalDraft["control"]> {
    const record = readRecord(value, path);
    assertKnownKeys(record, ["logLevel"], path);
    return {
        logLevel: readOptionalTrimmedString(record.logLevel, [...path, "logLevel"])
    };
}

function parseGlobalMcpDraft(value: unknown, path: readonly ConfigPathSegment[]): NonNullable<ConfigGlobalDraft["mcp"]> {
    const record = readRecord(value, path);
    assertKnownKeys(record, ["auth", "enabled", "listenHost", "listenPort", "publicBaseUrl"], path);

    return {
        auth: record.auth === undefined ? undefined : parseMcpAuthDraft(record.auth, [...path, "auth"]),
        enabled: readOptionalBoolean(record.enabled, [...path, "enabled"]),
        listenHost: readOptionalTrimmedString(record.listenHost, [...path, "listenHost"]),
        listenPort: readOptionalInteger(record.listenPort, [...path, "listenPort"]),
        publicBaseUrl: readNullable(record.publicBaseUrl, (entry) =>
            readRequiredTrimmedString(entry, [...path, "publicBaseUrl"])
        )
    };
}

function parseMcpAuthDraft(value: unknown, path: readonly ConfigPathSegment[]): ConfigMcpAuthDraft {
    const record = readRecord(value, path);
    assertKnownKeys(record, ["mode", "oauth2"], path);
    const mode = readEnum(record.mode, [...path, "mode"], ["none", "oauth2", "token"]);

    if (mode !== "oauth2") {
        if (record.oauth2 !== undefined) {
            throw configInputError("parse", [...path, "oauth2"], "config.auth.unexpectedOauth2", `must be omitted when mode=${mode}`);
        }
        return { mode };
    }

    if (record.oauth2 === undefined) {
        throw configInputError("parse", [...path, "oauth2"], "config.auth.oauth2Required", "is required when mode=oauth2");
    }

    const oauth2 = readRecord(record.oauth2, [...path, "oauth2"]);
    assertKnownKeys(
        oauth2,
        ["audience", "documentationUrl", "issuer", "jwksUri", "requiredScopes", "resourceName"],
        [...path, "oauth2"]
    );

    return {
        mode,
        oauth2: {
            audience: readOptionalTrimmedString(oauth2.audience, [...path, "oauth2", "audience"]),
            documentationUrl: readOptionalTrimmedString(oauth2.documentationUrl, [...path, "oauth2", "documentationUrl"]),
            issuer: readOptionalTrimmedString(oauth2.issuer, [...path, "oauth2", "issuer"]),
            jwksUri: readOptionalTrimmedString(oauth2.jwksUri, [...path, "oauth2", "jwksUri"]),
            requiredScopes:
                oauth2.requiredScopes === undefined
                    ? undefined
                    : readStringArray(oauth2.requiredScopes, [...path, "oauth2", "requiredScopes"]),
            resourceName: readRequiredTrimmedString(oauth2.resourceName, [...path, "oauth2", "resourceName"])
        }
    };
}

function parseInstanceMcpDraft(value: unknown, path: readonly ConfigPathSegment[]): NonNullable<ConfigInstanceDraft["mcp"]> {
    const record = readRecord(value, path);
    assertKnownKeys(record, ["enabled", "path", "tools"], path);

    const tools = record.tools === undefined ? undefined : readRecord(record.tools, [...path, "tools"]);
    if (tools !== undefined) {
        assertKnownKeys(tools, ["capabilities", "groups"], [...path, "tools"]);
    }

    return {
        enabled: readOptionalBoolean(record.enabled, [...path, "enabled"]),
        path: readOptionalTrimmedString(record.path, [...path, "path"]),
        tools:
            tools === undefined
                ? undefined
                : {
                      capabilities:
                          tools.capabilities === undefined
                              ? undefined
                              : readToolCapabilityArray(tools.capabilities, [...path, "tools", "capabilities"]),
                      groups:
                          tools.groups === undefined
                              ? undefined
                              : readStringArray(tools.groups, [...path, "tools", "groups"])
                  }
    };
}

function parseInstanceMcpPatch(value: unknown, path: readonly ConfigPathSegment[]): NonNullable<ConfigInstancePatch["mcp"]> {
    const record = readRecord(value, path);
    assertKnownKeys(record, ["enabled", "path", "tools"], path);
    const tools = record.tools === undefined ? undefined : readRecord(record.tools, [...path, "tools"]);
    if (tools !== undefined) {
        assertKnownKeys(tools, ["capabilities", "groups"], [...path, "tools"]);
    }

    return {
        enabled: readOptionalBoolean(record.enabled, [...path, "enabled"]),
        path: readNullable(record.path, (entry) => readRequiredTrimmedString(entry, [...path, "path"])),
        tools:
            tools === undefined
                ? undefined
                : {
                      capabilities:
                          tools.capabilities === undefined
                              ? undefined
                              : readToolCapabilityArray(tools.capabilities, [...path, "tools", "capabilities"]),
                      groups:
                          tools.groups === undefined
                              ? undefined
                              : readStringArray(tools.groups, [...path, "tools", "groups"])
                  }
    };
}

function parseContainerDraft(value: unknown, path: readonly ConfigPathSegment[]): ConfigContainerDraft {
    const record = readRecord(value, path);
    const mode = readEnum(record.mode, [...path, "mode"], [
        "preset",
        "dockerfile",
        "compose",
        "existingImage",
        "existingStoppedContainer"
    ]);

    switch (mode) {
        case "preset":
            assertKnownKeys(record, ["containerName", "env", "image", "mode", "mounts", "network", "preset", "user"], path);
            return {
                ...parseManagedContainer(record, path),
                image: readOptionalTrimmedString(record.image, [...path, "image"]),
                mode,
                preset: readRequiredTrimmedString(record.preset, [...path, "preset"])
            };
        case "dockerfile": {
            assertKnownKeys(record, ["build", "containerName", "env", "mode", "mounts", "network", "user"], path);
            const build = readRecord(record.build, [...path, "build"]);
            assertKnownKeys(build, ["context", "dockerfile", "tag"], [...path, "build"]);
            return {
                ...parseManagedContainer(record, path),
                build: {
                    context: readRequiredTrimmedString(build.context, [...path, "build", "context"]),
                    dockerfile: readOptionalTrimmedString(build.dockerfile, [...path, "build", "dockerfile"]),
                    tag: readOptionalTrimmedString(build.tag, [...path, "build", "tag"])
                },
                mode
            };
        }
        case "compose": {
            assertKnownKeys(record, ["compose", "mode"], path);
            const compose = readRecord(record.compose, [...path, "compose"]);
            assertKnownKeys(compose, ["file", "projectName", "service"], [...path, "compose"]);
            return {
                compose: {
                    file: readRequiredTrimmedString(compose.file, [...path, "compose", "file"]),
                    projectName: readOptionalTrimmedString(compose.projectName, [...path, "compose", "projectName"]),
                    service: readRequiredTrimmedString(compose.service, [...path, "compose", "service"])
                },
                mode
            };
        }
        case "existingImage":
            assertKnownKeys(record, ["containerName", "env", "image", "mode", "mounts", "network", "user"], path);
            return {
                ...parseManagedContainer(record, path),
                image: readRequiredTrimmedString(record.image, [...path, "image"]),
                mode
            };
        case "existingStoppedContainer":
            assertKnownKeys(record, ["adoptLifecycle", "containerName", "mode"], path);
            return {
                adoptLifecycle: readOptionalBoolean(record.adoptLifecycle, [...path, "adoptLifecycle"]),
                containerName: readRequiredTrimmedString(record.containerName, [...path, "containerName"]),
                mode
            };
    }
}

function parseManagedContainer(record: Record<string, unknown>, path: readonly ConfigPathSegment[]) {
    return {
        containerName: readOptionalTrimmedString(record.containerName, [...path, "containerName"]),
        env: readOptionalStringRecord(record.env, [...path, "env"]),
        mounts:
            record.mounts === undefined
                ? undefined
                : readArray(record.mounts, [...path, "mounts"]).map((entry, index) => {
                      const mountPath = [...path, "mounts", index] as const;
                      const mount = readRecord(entry, mountPath);
                      assertKnownKeys(mount, ["mode", "selinux", "source", "target"], mountPath);
                      return {
                          mode: readEnum(mount.mode, [...mountPath, "mode"], ["ro", "rw"]),
                          selinux:
                              mount.selinux === undefined
                                  ? undefined
                                  : readEnum(mount.selinux, [...mountPath, "selinux"], ["private", "shared"]),
                          source: readRequiredTrimmedString(mount.source, [...mountPath, "source"]),
                          target: readRequiredTrimmedString(mount.target, [...mountPath, "target"])
                      };
                  }),
        network: readOptionalTrimmedString(record.network, [...path, "network"]),
        user: readOptionalTrimmedString(record.user, [...path, "user"])
    };
}

function parseApprovalPolicy(value: unknown, path: readonly ConfigPathSegment[]): ApprovalPolicy {
    const record = readRecord(value, path);
    assertKnownKeys(record, ["mode", "rules"], path);

    return {
        mode: readEnum<ApprovalPolicyMode>(record.mode, [...path, "mode"], ["disabled", "allow", "ask", "deny"]),
        rules:
            record.rules === undefined
                ? undefined
                : readArray(record.rules, [...path, "rules"]).map((entry, index) => {
                      const rulePath = [...path, "rules", index] as const;
                      const rule = readRecord(entry, rulePath);
                      assertKnownKeys(rule, ["decision", "match", "source", "toolName"], rulePath);
                      return {
                          decision: readEnum<ApprovalPolicyDecision>(rule.decision, [...rulePath, "decision"], [
                              "allow",
                              "ask",
                              "deny"
                          ]),
                          match: readEnum(rule.match, [...rulePath, "match"], ["exact"]),
                          source: readEnum<ApprovalPolicySourceScope>(rule.source, [...rulePath, "source"], [
                              "all",
                              "cli",
                              "tui",
                              "mcp"
                          ]),
                          toolName: readOptionalTrimmedString(rule.toolName, [...rulePath, "toolName"])
                      };
                  })
    };
}

function parseLogs(value: unknown, path: readonly ConfigPathSegment[]): ControlInstanceLogsConfig {
    const record = readRecord(value, path);
    assertKnownKeys(record, ["eventBufferSize", "maxBytes", "retentionDays"], path);
    return {
        eventBufferSize: readOptionalInteger(record.eventBufferSize, [...path, "eventBufferSize"]),
        maxBytes: readOptionalInteger(record.maxBytes, [...path, "maxBytes"]),
        retentionDays: readOptionalInteger(record.retentionDays, [...path, "retentionDays"])
    };
}

function parseSecurityDraft(value: unknown, path: readonly ConfigPathSegment[]): { mode?: ControlSecurityMode } {
    const record = readRecord(value, path);
    assertKnownKeys(record, ["mode"], path);
    return {
        mode:
            record.mode === undefined
                ? undefined
                : readEnum<ControlSecurityMode>(record.mode, [...path, "mode"], ["disabled", "workspace"])
    };
}

function parseSshDraft(value: unknown, path: readonly ConfigPathSegment[]): { command?: string } {
    const record = readRecord(value, path);
    assertKnownKeys(record, ["command"], path);
    return {
        command: readOptionalOpaqueString(record.command, [...path, "command"])
    };
}

function parseTools(value: unknown, path: readonly ConfigPathSegment[]): ControlInstanceToolsConfig {
    const record = readRecord(value, path);
    assertKnownKeys(record, ["scheduler"], path);
    return {
        scheduler:
            record.scheduler === undefined
                ? undefined
                : parseScheduler(record.scheduler, [...path, "scheduler"])
    };
}

function parseScheduler(value: unknown, path: readonly ConfigPathSegment[]): ControlToolSchedulerConfig {
    const record = readRecord(value, path);
    assertKnownKeys(
        record,
        ["byTool", "maxRunning", "maxRunningPerSession", "queueDepth", "queueDepthPerSession", "queueTimeoutMs"],
        path
    );

    let byTool: Record<string, { maxRunning?: number; queueDepth?: number }> | undefined;
    if (record.byTool !== undefined) {
        const rawByTool = readRecord(record.byTool, [...path, "byTool"]);
        byTool = Object.fromEntries(
            Object.entries(rawByTool).map(([toolName, value]) => {
                if (toolName.trim().length === 0) {
                    throw configInputError("parse", [...path, "byTool", toolName], "config.scheduler.toolName", "must not be empty");
                }
                const toolPath = [...path, "byTool", toolName] as const;
                const tool = readRecord(value, toolPath);
                assertKnownKeys(tool, ["maxRunning", "queueDepth"], toolPath);
                return [
                    toolName,
                    {
                        maxRunning: readOptionalInteger(tool.maxRunning, [...toolPath, "maxRunning"]),
                        queueDepth: readOptionalInteger(tool.queueDepth, [...toolPath, "queueDepth"])
                    }
                ];
            })
        );
    }

    return {
        byTool,
        maxRunning: readOptionalInteger(record.maxRunning, [...path, "maxRunning"]),
        maxRunningPerSession: readOptionalInteger(record.maxRunningPerSession, [...path, "maxRunningPerSession"]),
        queueDepth: readOptionalInteger(record.queueDepth, [...path, "queueDepth"]),
        queueDepthPerSession: readOptionalInteger(record.queueDepthPerSession, [...path, "queueDepthPerSession"]),
        queueTimeoutMs: readOptionalInteger(record.queueTimeoutMs, [...path, "queueTimeoutMs"])
    };
}

function readRecord(value: unknown, path: readonly ConfigPathSegment[]): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw configInputError("parse", path, "config.type.object", "must be an object");
    }
    return value as Record<string, unknown>;
}

function readArray(value: unknown, path: readonly ConfigPathSegment[]): unknown[] {
    if (!Array.isArray(value)) {
        throw configInputError("parse", path, "config.type.array", "must be an array");
    }
    return value;
}

function readRequiredTrimmedString(value: unknown, path: readonly ConfigPathSegment[]): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw configInputError("parse", path, "config.type.nonEmptyString", "must be a non-empty string");
    }
    return value.trim();
}

function readOptionalTrimmedString(value: unknown, path: readonly ConfigPathSegment[]): string | undefined {
    if (value === undefined) return undefined;
    return readRequiredTrimmedString(value, path);
}

function readOptionalOpaqueString(value: unknown, path: readonly ConfigPathSegment[]): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.trim().length === 0) {
        throw configInputError("parse", path, "config.type.nonEmptyString", "must be a non-empty string");
    }
    return value;
}

function readOptionalBoolean(value: unknown, path: readonly ConfigPathSegment[]): boolean | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "boolean") {
        throw configInputError("parse", path, "config.type.boolean", "must be a boolean");
    }
    return value;
}

function readOptionalInteger(value: unknown, path: readonly ConfigPathSegment[]): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        throw configInputError("parse", path, "config.type.integer", "must be an integer");
    }
    return value;
}

function readStringArray(value: unknown, path: readonly ConfigPathSegment[]): string[] {
    return readArray(value, path).map((entry, index) => readRequiredTrimmedString(entry, [...path, index]));
}

function readToolCapabilityArray(value: unknown, path: readonly ConfigPathSegment[]): ToolCapability[] {
    return readStringArray(value, path).map((entry, index) => {
        if (entry === "read" || entry === "write" || entry === "execute" || entry === "manage") return entry;
        throw configInputError(
            "parse",
            [...path, index],
            "config.toolCapability.invalid",
            "must be one of read, write, execute, manage"
        );
    });
}

function readStringRecord(value: unknown, path: readonly ConfigPathSegment[]): Record<string, string> {
    const record = readRecord(value, path);
    return Object.fromEntries(
        Object.entries(record).map(([key, entry]) => {
            if (typeof entry !== "string") {
                throw configInputError("parse", [...path, key], "config.type.string", "must be a string");
            }
            return [key, entry];
        })
    );
}

function readOptionalStringRecord(value: unknown, path: readonly ConfigPathSegment[]): Record<string, string> | undefined {
    return value === undefined ? undefined : readStringRecord(value, path);
}

function readEnum<T extends string>(value: unknown, path: readonly ConfigPathSegment[], values: readonly T[]): T {
    const normalized = readRequiredTrimmedString(value, path);
    if ((values as readonly string[]).includes(normalized)) return normalized as T;
    throw configInputError("parse", path, "config.enum.invalid", `must be one of ${values.join(", ")}`);
}

function readNullable<T>(value: unknown, parse: (value: unknown) => T): T | null | undefined {
    if (value === undefined) return undefined;
    if (value === null) return null;
    return parse(value);
}

function assertKnownKeys(
    record: Record<string, unknown>,
    allowed: readonly string[],
    path: readonly ConfigPathSegment[]
): void {
    const allowedKeys = new Set(allowed);
    const unknown = Object.keys(record).find((key) => !allowedKeys.has(key));
    if (unknown !== undefined) {
        throw configInputError("parse", [...path, unknown], "config.field.unknown", "is not supported");
    }
}

export type ParsedControlProviderKind = ControlProviderKind;
