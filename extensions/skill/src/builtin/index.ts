import type { ExtensionContext } from "@portable-devshell/extension";
import { commands } from "@portable-devshell/extension/cli";

import { executeSkillCommand } from "./SkillCommand.js";

export * from "./SkillCatalog.js";
export { executeSkillCommand, SKILL_USAGE } from "./SkillCommand.js";

export function activate(context: ExtensionContext): void {
    context.register(
        commands,
        "skill",
        async (argv, invocation) => await executeSkillCommand(context, argv, invocation)
    );
}
