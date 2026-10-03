export type ExtensionJsonPrimitive = boolean | number | string | null;
export type ExtensionJsonValue =
    | ExtensionJsonPrimitive
    | ExtensionJsonValue[]
    | { [key: string]: ExtensionJsonValue };

export interface ExtensionPointDeclaration {
    readonly id: string;
    readonly [key: string]: ExtensionJsonValue | undefined;
}

declare const extensionPointDeclarationType: unique symbol;
declare const extensionPointBindingType: unique symbol;

/** Stable domain-owned point identity plus compile-time declaration/binding types. */
export interface ExtensionPoint<
    Declaration extends ExtensionPointDeclaration,
    Binding,
> {
    readonly id: string;
    readonly [extensionPointBindingType]?: Binding;
    readonly [extensionPointDeclarationType]?: Declaration;
}

/**
 * Define a stable Extension Point descriptor. Runtime identity is the id string,
 * never JavaScript object identity, so descriptors may safely be bundled.
 */
export function defineExtensionPoint<
    Declaration extends ExtensionPointDeclaration,
    Binding,
>(id: string): ExtensionPoint<Declaration, Binding> {
    if (!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/u.test(id)) {
        throw new TypeError(
            "Extension Point id must be a lowercase namespaced identifier.",
        );
    }
    return Object.freeze({ id }) as ExtensionPoint<Declaration, Binding>;
}
