import type { ExtensionActivation, ExtensionContext } from "@portable-devshell/extension";

import { executeSkillCommand } from "./SkillCommand.js";

export * from "./SkillCatalog.js";
export { executeSkillCommand, SKILL_USAGE } from "./SkillCommand.js";

export function activate(context: ExtensionContext): ExtensionActivation {
    return {
        command: async (argv, invocation) => await executeSkillCommand(context, argv, invocation),
        dispose() {}
    };
}
