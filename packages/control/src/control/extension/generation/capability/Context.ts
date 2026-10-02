import type {
    ExtensionContextRuntimeCapability,
    ExtensionContextRuntimeQuery,
    ExtensionContextRuntimeRecord,
    ExtensionContextRuntimeStatus,
} from "@portable-devshell/extension/context";
import type { McpContextRecord } from "@portable-devshell/shared";

export class ExtensionContextRuntimeCapabilityControl
    implements ExtensionContextRuntimeCapability
{
    readonly #allowed: boolean;
    readonly #extensionId: string;
    readonly #listContexts: () => Promise<readonly McpContextRecord[]>;

    constructor(options: {
        allowed: boolean;
        extensionId: string;
        listContexts: () => Promise<readonly McpContextRecord[]>;
    }) {
        this.#allowed = options.allowed;
        this.#extensionId = options.extensionId;
        this.#listContexts = options.listContexts;
    }

    async list(
        query: ExtensionContextRuntimeQuery = {},
    ): Promise<readonly ExtensionContextRuntimeRecord[]> {
        this.#assertAllowed();
        const normalized = readQuery(query);
        return (await this.#listContexts())
            .filter((record) => matches(record, normalized))
            .map(toRuntimeRecord);
    }

    #assertAllowed(): void {
        if (this.#allowed) return;
        throw new Error(
            `Extension ${this.#extensionId} did not declare the contextRuntime capability.`,
        );
    }
}

function readQuery(
    query: ExtensionContextRuntimeQuery,
): ExtensionContextRuntimeQuery {
    if (typeof query !== "object" || query === null || Array.isArray(query)) {
        throw new TypeError(
            "Extension contextRuntime list query must be an object.",
        );
    }
    if (query.instance !== undefined) requireString(query.instance, "instance");
    if (query.workspace !== undefined)
        requireString(query.workspace, "workspace");
    if (query.status !== undefined && !isContextStatus(query.status)) {
        throw new TypeError(
            "Extension contextRuntime list status must be active, expired, or disabled.",
        );
    }
    return query;
}

function requireString(value: string, field: string): void {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new TypeError(
            `Extension contextRuntime list ${field} must be a non-empty string.`,
        );
    }
}

function isContextStatus(value: unknown): value is ExtensionContextRuntimeStatus {
    return value === "active" || value === "expired" || value === "disabled";
}

function matches(
    record: McpContextRecord,
    query: ExtensionContextRuntimeQuery,
): boolean {
    if (query.status !== undefined && record.status !== query.status) return false;
    if (
        query.instance !== undefined &&
        record.instance !== query.instance &&
        !record.environments.some(
            (environment) => environment.instance === query.instance,
        )
    ) {
        return false;
    }
    if (
        query.workspace !== undefined &&
        record.workspace !== query.workspace &&
        !record.environments.some(
            (environment) => environment.workspace === query.workspace,
        )
    ) {
        return false;
    }
    return true;
}

function toRuntimeRecord(
    record: McpContextRecord,
): ExtensionContextRuntimeRecord {
    return {
        createdAt: record.createdAt,
        ctxId: record.ctxId,
        environments: record.environments.map((environment) => ({
            instance: environment.instance,
            ...(environment.workspace === undefined
                ? {}
                : { workspace: environment.workspace }),
        })),
        expiresAt: record.expiresAt,
        instance: record.instance,
        lastAccessedAt: record.lastAccessedAt,
        status: record.status,
        workspace: record.workspace,
    };
}
