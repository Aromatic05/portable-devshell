export {
    createDevshellPiExtension,
    createDevshellPiWorkspaceBridge,
} from "./Bridge.js";
export type {
    DevshellPiExtensionAttachOptions,
    DevshellPiExtensionOptions,
    DevshellPiToolDefinition,
    DevshellPiToolSession,
    DevshellPiWorkspaceBridge,
    PiExtensionApiLike,
    PiToolLike,
} from "./Bridge.js";
export type { DevshellPiTarget } from "./Target.js";

export {
    createStandaloneDevshellPiExtension,
    openStandaloneDevshellPiToolSession,
    parseStandaloneDevshellPiTarget,
    standaloneDevshellPiExtension,
} from "./StandaloneClient.js";
export type { StandaloneDevshellPiOptions } from "./StandaloneClient.js";

export {
    buildDevshellPiSystemPrompt,
} from "./StandaloneResources.js";

export {
    expandDevshellPiPromptTemplate,
    loadDevshellPiWorkspaceContext,
    loadDevshellPiWorkspaceResources,
    transformDevshellPiSkillInput,
} from "./WorkspaceResources.js";
export type {
    DevshellPiContextFile,
    DevshellPiWorkspaceResources,
    DevshellPiWorkspaceSkill,
} from "./WorkspaceResources.js";

export { standaloneDevshellPiExtension as default } from "./StandaloneClient.js";
