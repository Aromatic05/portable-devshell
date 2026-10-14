import type { ExtensionContext } from "@portable-devshell/extension";
import { environment } from "@portable-devshell/extension/execution";

/** Control selects this versioned driver at Worker start; evaluation runs on the target host. */
export function activate(context: ExtensionContext): void {
    context.register(environment, "direnv", Object.freeze({ name: "direnv", version: 1, executable: "direnv", args: ["export", "json"] }));
}
