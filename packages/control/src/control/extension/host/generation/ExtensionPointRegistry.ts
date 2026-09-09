import type { ExtensionPointDeclaration } from "@portable-devshell/extension";

export interface ExtensionPointValidationContext {
    readonly codeDirectory: string;
    readonly extensionId: string;
    readonly id: string;
}

export interface ExtensionPointDefinition {
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

    parseDeclaration(
        pointId: string,
        declaration: ExtensionPointDeclaration,
        extensionId: string
    ): ExtensionPointDeclaration {
        return this.#require(pointId, extensionId).parseDeclaration(declaration);
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
