import type {
    McpExtension,
    McpExtensionPresentation,
    McpExtensionResource,
    McpExtensionResourceDescriptor,
    McpExtensionResourceReadResult,
} from "./Contract.js";

interface ResourceRegistration {
    readonly extensionId: string;
    readonly resource: McpExtensionResource;
}

export class McpExtensionRegistry {
    readonly #extensions: readonly McpExtension[];
    readonly #presentation?: McpExtensionPresentation;
    readonly #resources = new Map<string, ResourceRegistration>();

    constructor(extensions: readonly McpExtension[] = []) {
        const ids = new Set<string>();
        let presentation: McpExtensionPresentation | undefined;
        for (const extension of extensions) {
            validateExtensionId(extension.id);
            if (ids.has(extension.id))
                throw new TypeError(
                    "MCP Extension " + extension.id + " is registered more than once.",
                );
            ids.add(extension.id);
            const ownedResourceUris = new Set<string>();
            for (const resource of extension.resources ?? []) {
                registerResource(
                    this.#resources,
                    ownedResourceUris,
                    extension.id,
                    resource,
                );
            }
            if (extension.presentation?.bootstrap === "environment") {
                if (!ownedResourceUris.has(extension.presentation.resourceUri))
                    throw new TypeError(
                        "MCP Extension " +
                            extension.id +
                            " environment presentation must reference one of its resources.",
                    );
                if (presentation !== undefined)
                    throw new TypeError(
                        "MCP environment presentation is registered more than once.",
                    );
                presentation = extension.presentation;
            }
        }
        this.#extensions = Object.freeze([...extensions]);
        this.#presentation = presentation;
    }

    environmentPresentation(): McpExtensionPresentation | undefined {
        return this.#presentation;
    }

    hasAppResources(): boolean {
        return this.#extensions.some((extension) =>
            (extension.resources ?? []).some((resource) => resource.app === true),
        );
    }

    listResources(): readonly McpExtensionResourceDescriptor[] {
        return this.#extensions.flatMap((extension) =>
            (extension.resources ?? []).map((resource) =>
                Object.freeze({
                    mimeType: resource.mimeType,
                    name: resource.name,
                    uri: resource.uri,
                }),
            ),
        );
    }

    async readResource(
        uri: string,
    ): Promise<McpExtensionResourceReadResult | undefined> {
        const registration = this.#resources.get(uri);
        if (registration === undefined) return undefined;
        const content = await registration.resource.read(uri);
        if (
            typeof content !== "object" ||
            content === null ||
            typeof content.text !== "string" ||
            (content._meta !== undefined &&
                (typeof content._meta !== "object" ||
                    content._meta === null ||
                    Array.isArray(content._meta)))
        )
            throw new TypeError(
                "MCP Extension " +
                    registration.extensionId +
                    " resource " +
                    registration.resource.uri +
                    " returned invalid content.",
            );
        return Object.freeze({
            ...(content._meta === undefined ? {} : { _meta: content._meta }),
            mimeType: registration.resource.mimeType,
            name: registration.resource.name,
            text: content.text,
            uri,
        });
    }
}

function registerResource(
    resources: Map<string, ResourceRegistration>,
    ownedResourceUris: Set<string>,
    extensionId: string,
    resource: McpExtensionResource,
): void {
    for (const [field, value] of [
        ["uri", resource.uri],
        ["name", resource.name],
        ["mimeType", resource.mimeType],
    ] as const) {
        if (typeof value !== "string" || value.length === 0)
            throw new TypeError(
                "MCP Extension " +
                    extensionId +
                    " resource " +
                    field +
                    " must be a non-empty string.",
            );
    }
    const uris = [resource.uri, ...(resource.aliases ?? [])];
    for (const uri of uris) {
        if (typeof uri !== "string" || uri.length === 0)
            throw new TypeError(
                "MCP Extension " +
                    extensionId +
                    " resource aliases must be non-empty strings.",
            );
        if (resources.has(uri))
            throw new TypeError("MCP resource " + uri + " is registered more than once.");
        resources.set(uri, { extensionId, resource });
        ownedResourceUris.add(uri);
    }
}

function validateExtensionId(id: string): void {
    if (!/^[a-z][a-z0-9-]*$/u.test(id))
        throw new TypeError("MCP Extension id must match [a-z][a-z0-9-]*.");
}
