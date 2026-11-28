import type {
    CodeDescribeRequest,
    CodeDescribeResult,
    CodeEvalRequest,
    CodeEvalResult,
    CodeLogEntry,
    JsonValue,
} from "@portable-devshell/shared";

export type CodeAudience = "model" | "native";
export type CodeObjectScopeLevel = "control" | "instance";

export interface CodeExecutionPrincipal {
    readonly allowedExtensions?: readonly string[];
    readonly audience: CodeAudience;
    readonly ctxId?: string;
    readonly instance?: string;
    readonly localOwner: boolean;
    readonly requestId: string;
    readonly workingDirectory?: string;
    readonly workspace?: string;
}

export interface CodeMethodDescriptor {
    readonly audiences: readonly CodeAudience[];
    readonly example?: string;
    readonly inputSchema: JsonValue;
    readonly name: string;
    readonly outputSchema?: JsonValue;
    readonly summary: string;
}

export interface CodeObjectDescriptor {
    readonly callable?: boolean;
    readonly extensionId?: string;
    readonly id: string;
    readonly methods: readonly CodeMethodDescriptor[];
    readonly scopeLevel: CodeObjectScopeLevel;
    readonly summary: string;
}

export interface CodeMethodInvocationContext {
    readonly audience: CodeAudience;
    readonly ctxId?: string;
    readonly instance?: string;
    readonly localOwner: boolean;
    readonly parentCallId: string;
    readonly requestId: string;
    readonly signal: AbortSignal;
    readonly workingDirectory?: string;
    readonly workspace?: string;
}

export interface CodeObjectProvider {
    describe(
        principal: CodeExecutionPrincipal,
        instance?: string,
    ): readonly CodeObjectDescriptor[];
    invoke(
        objectId: string,
        method: string,
        input: JsonValue,
        context: CodeMethodInvocationContext,
    ): Promise<JsonValue | undefined>;
    openHandle?(
        objectId: string,
        target: JsonValue,
        context: CodeMethodInvocationContext,
    ): Promise<string>;
    invokeHandle?(
        objectId: string,
        handleId: string,
        method: string,
        input: JsonValue,
        context: CodeMethodInvocationContext,
    ): Promise<JsonValue | undefined>;
    closeHandle?(objectId: string, handleId: string): Promise<void>;
    owns(
        objectId: string,
        principal: CodeExecutionPrincipal,
        instance?: string,
    ): boolean;
}

export interface CodeEvalOptions {
    readonly onLog?: (entry: CodeLogEntry) => void;
    readonly principal: CodeExecutionPrincipal;
    readonly signal?: AbortSignal;
}

export interface CodePort {
    describe(
        request: CodeDescribeRequest,
        principal: CodeExecutionPrincipal,
    ): CodeDescribeResult;
    eval(
        request: CodeEvalRequest,
        options: CodeEvalOptions,
    ): Promise<CodeEvalResult>;
}

export interface CodeRuntime extends CodePort {
    registerProvider(provider: CodeObjectProvider): () => void;
}
