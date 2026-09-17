import { readSecretEnvironment } from "@portable-devshell/extension/secret";
import type {
    ToolCallRewriteBinding,
    ToolCallRewriteContext,
    ToolCallRewriteInvocation,
} from "@portable-devshell/extension/toolcall";

import { expandSecretReferences } from "./SecretExpand.js";
import { maskSecretValues } from "./SecretMask.js";

export { expandSecretReferences } from "./SecretExpand.js";
export { maskSecretValues } from "./SecretMask.js";


export function createSecretRewrite(): ToolCallRewriteBinding {
    return async (
        input: ToolCallRewriteInvocation,
        context: ToolCallRewriteContext,
    ): Promise<string> => {
        const environment = await readSecretEnvironment(context);
        return input.direction === "inbound"
            ? expandSecretReferences(input.text, environment, input.context.instance)
            : maskSecretValues(input.text, environment);
    };
}
