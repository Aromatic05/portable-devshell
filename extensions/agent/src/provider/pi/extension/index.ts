export {
    createDevshellPiExtension,
    createDevshellPiWorkspaceBridge,
    piPromptMetadata
} from "./DevshellPiBridge.js";
export type {
    DevshellPiExtensionAttachOptions,
    DevshellPiExtensionOptions,
    DevshellPiToolDefinition,
    DevshellPiToolSession,
    DevshellPiWorkspaceBridge,
    PiExtensionApiLike,
    PiToolLike
} from "./DevshellPiBridge.js";
export type { DevshellPiTarget } from "./DevshellPiTarget.js";

export {
    createStandaloneDevshellPiExtension,
    openStandaloneDevshellPiToolSession,
    parseStandaloneDevshellPiTarget,
    standaloneDevshellPiExtension
} from "./standalone-client.js";
export type { StandaloneDevshellPiOptions } from "./standalone-client.js";

export {
    appendDevshellRemoteWorkspacePrompt,
    replacePiProjectContext
} from "./standalone-resources.js";

export {
    expandDevshellPiPromptTemplate,
    loadDevshellPiWorkspaceContext,
    loadDevshellPiWorkspaceResources,
    transformDevshellPiSkillInput
} from "./workspace-resources.js";
export type {
    DevshellPiContextFile,
    DevshellPiWorkspaceResources,
    DevshellPiWorkspaceSkill
} from "./workspace-resources.js";

export { standaloneDevshellPiExtension as default } from "./standalone-client.js";
