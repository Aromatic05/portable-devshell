import type { ExtensionJsonValue } from "@portable-devshell/extension";
import { readSecretEnvironment } from "@portable-devshell/extension/secret";
import type {
    ToolCallRewriteBinding,
    ToolCallRewriteContext,
    ToolCallRewriteInvocation,
} from "@portable-devshell/extension/toolcall";

import {
    expandSecretReferences,
    secretReferenceNames,
} from "./SecretExpand.js";
import { maskSecretValues } from "./SecretMask.js";

export {
    expandSecretReferences,
    secretReferenceNames,
} from "./SecretExpand.js";
export { maskSecretValues } from "./SecretMask.js";

export function createSecretRewrite(): ToolCallRewriteBinding {
    return async (
        input: ToolCallRewriteInvocation,
        context: ToolCallRewriteContext,
    ): Promise<ExtensionJsonValue> => {
        if (input.direction === "inbound") {
            const names = secretNames(input.payload);
            if (names.length === 0) return input.payload;
            const environment = await readSecretEnvironment(context, names);
            return mapStrings(
                input.payload,
                (text) =>
                    expandSecretReferences(
                        text,
                        environment,
                        input.context.instance,
                    ),
            );
        }
        const environment = await readSecretEnvironment(context);
        return mapStrings(
            input.payload,
            (text) => maskSecretValues(text, environment),
        );
    };
}

function secretNames(value: ExtensionJsonValue): readonly string[] {
    const names = new Set<string>();
    visitStrings(value, (text) => {
        for (const name of secretReferenceNames(text)) names.add(name);
    });
    return [...names];
}

function mapStrings(
    value: ExtensionJsonValue,
    transform: (text: string) => string,
): ExtensionJsonValue {
    if (typeof value === "string") return transform(value);
    if (Array.isArray(value))
        return value.map((entry) => mapStrings(entry, transform));
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
            key,
            mapStrings(entry, transform),
        ]),
    );
}

function visitStrings(
    value: ExtensionJsonValue,
    visit: (text: string) => void,
): void {
    const stack: ExtensionJsonValue[] = [value];
    while (stack.length > 0) {
        const current = stack.pop()!;
        if (typeof current === "string") {
            visit(current);
            continue;
        }
        if (typeof current !== "object" || current === null) continue;
        if (Array.isArray(current)) stack.push(...current);
        else stack.push(...Object.values(current));
    }
}
