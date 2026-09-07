export type ExtensionJsonPrimitive = boolean | number | string | null;
export type ExtensionJsonValue =
    | ExtensionJsonPrimitive
    | ExtensionJsonValue[]
    | { [key: string]: ExtensionJsonValue };

export type ExtensionCapability =
    | "command"
    | "instance-lifecycle"
    | "rpc"
    | "web"
    | "worker";

export interface ExtensionManifest {
    apiVersion: number;
    capabilities: readonly ExtensionCapability[];
    entry: string;
    id: string;
    name: string;
    schemaVersion: number;
    version: string;
}

export interface ExtensionPaths {
    /** Immutable directory containing the selected generation. */
    codeDirectory: string;
    /** Ephemeral per-generation directory owned by Control. */
    runtimeDirectory: string;
    /** Mutable extension state shared across generations. */
    stateDirectory: string;
}

export interface ExtensionLogger {
    debug(message: string, details?: ExtensionJsonValue): void;
    error(message: string, details?: ExtensionJsonValue): void;
    info(message: string, details?: ExtensionJsonValue): void;
    warn(message: string, details?: ExtensionJsonValue): void;
}

export interface ExtensionToolDefinition {
    description: string;
    inputSchema: ExtensionJsonValue;
    name: string;
}

export interface ExtensionWorkerOpenInput {
    instance?: string;
    workspace: string;
}

export interface ExtensionWorkerCallOptions {
    operationId?: string;
    signal?: AbortSignal;
}

export interface ExtensionWorkerSession {
    readonly instance: string;
    readonly workspace: string;
    callTool(
        toolName: string,
        input: ExtensionJsonValue,
        options?: ExtensionWorkerCallOptions
    ): Promise<ExtensionJsonValue>;
    close(): Promise<void>;
    listTools(): readonly ExtensionToolDefinition[];
}

export interface ExtensionWorkerCapability {
    openSession(input: ExtensionWorkerOpenInput): Promise<ExtensionWorkerSession>;
}

export interface ExtensionContext {
    readonly generation: string;
    readonly id: string;
    readonly logger: ExtensionLogger;
    readonly paths: ExtensionPaths;
    readonly version: string;
    readonly worker: ExtensionWorkerCapability;
}

export interface ExtensionInvocationContext {
    readonly requestId: string;
    readonly signal: AbortSignal;
}

export type ExtensionRpcHandler = (
    input: ExtensionJsonValue | undefined,
    context: ExtensionInvocationContext
) => ExtensionJsonValue | Promise<ExtensionJsonValue>;

export type ExtensionCommandResult =
    | { kind: "json"; value: ExtensionJsonValue }
    | { kind: "text"; text: string };

export type ExtensionCommandHandler = (
    argv: readonly string[],
    context: ExtensionInvocationContext
) => ExtensionCommandResult | Promise<ExtensionCommandResult>;

export type ExtensionWebContribution =
    | {
          /** Relative directory below codeDirectory. */
          directory: string;
          kind: "static";
      }
    | {
          kind: "proxy";
          resolveUpstream(): URL | Promise<URL | undefined> | undefined;
      };

export interface ExtensionInstanceRetireEvent {
    instance: string;
    reason: "deleted" | "disabled";
}

export interface ExtensionLifecycleHandlers {
    onInstanceRetire?(event: ExtensionInstanceRetireEvent): Promise<void> | void;
}

export interface ExtensionActivation {
    command?: ExtensionCommandHandler;
    dispose(): Promise<void> | void;
    lifecycle?: ExtensionLifecycleHandlers;
    rpc?: Readonly<Record<string, ExtensionRpcHandler>>;
    web?: ExtensionWebContribution;
}

export interface ExtensionModule {
    activate(context: ExtensionContext): ExtensionActivation | Promise<ExtensionActivation>;
}
