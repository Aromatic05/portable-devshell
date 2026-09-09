import type { ExtensionContext } from "@portable-devshell/extension";
import { modelCommands, nativeCommands } from "@portable-devshell/extension/cli";

import { executeSkillCommand } from "./SkillCommand.js";
import { executeSkillModelCommand } from "./SkillModelCommand.js";

export * from "./SkillCatalog.js";
export { executeSkillCommand, SKILL_USAGE } from "./SkillCommand.js";
export { executeSkillModelCommand, SKILL_MODEL_USAGE } from "./SkillModelCommand.js";

export function activate(context: ExtensionContext): void {
    context.register(
        nativeCommands,
        "skill",
        async (argv, invocation) => await executeSkillCommand(context, argv, invocation)
    );
    context.register(
        modelCommands,
        "skill",
        async (argv, invocation) => await executeSkillModelCommand(context, argv, invocation)
    );
}
