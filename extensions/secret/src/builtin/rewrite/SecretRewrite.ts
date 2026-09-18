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
    ): Promise<string> => {
        if (input.direction === "inbound") {
            const names = secretReferenceNames(input.text);
            if (names.length === 0) return input.text;
            const environment = await readSecretEnvironment(context, names);
            return expandSecretReferences(
                input.text,
                environment,
                input.context.instance,
            );
        }
        return maskSecretValues(
            input.text,
            await readSecretEnvironment(context),
        );
    };
}
