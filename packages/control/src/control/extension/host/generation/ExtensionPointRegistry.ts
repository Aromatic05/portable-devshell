import type {
    ExtensionJsonValue,
    ExtensionPointDeclaration
} from "@portable-devshell/extension";

export interface ExtensionPointValidationContext {
    readonly codeDirectory: string;
    readonly extensionId: string;
    readonly id: string;
}

export interface ExtensionPointSandboxInvokeOptions {
    readonly signal?: AbortSignal;
    readonly timeoutLabel?: string;
}

export interface ExtensionPointSandboxBridge {
    invokeBinding(
        pointId: string,
        id: string,
        input?: ExtensionJsonValue,
        options?: ExtensionPointSandboxInvokeOptions
    ): Promise<unknown>;
}

export interface ExtensionPointDefinition {
    createSandboxBinding?(
        descriptor: ExtensionJsonValue,
        context: ExtensionPointValidationContext,
        bridge: ExtensionPointSandboxBridge
    ): unknown;
    readonly id: string;
    parseDeclaration(declaration: ExtensionPointDeclaration): ExtensionPointDeclaration;
    validateBinding(binding: unknown, context: ExtensionPointValidationContext): void;
    validateBindingResources?(
        binding: unknown,
        context: ExtensionPointValidationContext
    ): Promise<void> | void;
}

/** Internal registry of domain-owned Extension Point contracts. */
export class ExtensionPointRegistry {
    readonly #definitions = new Map<string, ExtensionPointDefinition>();

    constructor(definitions: readonly ExtensionPointDefinition[]) {
        for (const definition of definitions) {
            if (!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/u.test(definition.id)) {
                throw new TypeError(`Extension Point id must be a lowercase namespaced id: ${definition.id}.`);
            }
            if (this.#definitions.has(definition.id)) {
                throw new TypeError(`Extension Point ${definition.id} is registered more than once.`);
            }
            this.#definitions.set(definition.id, definition);
        }
    }

    ids(): readonly string[] {
        return Object.freeze([...this.#definitions.keys()].sort());
    }

    parseDeclaration(
        pointId: string,
        declaration: ExtensionPointDeclaration,
        extensionId: string
    ): ExtensionPointDeclaration {
        return this.#require(pointId, extensionId).parseDeclaration(declaration);
    }

    createSandboxBinding(
        pointId: string,
        descriptor: ExtensionJsonValue,
        context: ExtensionPointValidationContext,
        bridge: ExtensionPointSandboxBridge
    ): unknown {
        const create = this.#require(pointId, context.extensionId).createSandboxBinding;
        if (create === undefined) {
            throw new TypeError(`Extension Point ${pointId} does not support sandbox bindings.`);
        }
        return create(descriptor, context, bridge);
    }

    validateBinding(
        pointId: string,
        binding: unknown,
        context: ExtensionPointValidationContext
    ): void {
        this.#require(pointId, context.extensionId).validateBinding(binding, context);
    }

    async validateBindingResources(
        pointId: string,
        binding: unknown,
        context: ExtensionPointValidationContext
    ): Promise<void> {
        await this.#require(pointId, context.extensionId).validateBindingResources?.(binding, context);
    }

    #require(pointId: string, extensionId: string): ExtensionPointDefinition {
        const definition = this.#definitions.get(pointId);
        if (definition !== undefined) return definition;
        throw new TypeError(`Extension ${extensionId} declares unsupported Extension Point ${pointId}.`);
    }
}
