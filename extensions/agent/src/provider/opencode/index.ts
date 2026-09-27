export {
    OPENCODE_PROVIDER_ID,
    OPENCODE_PROVIDER_VERSION,
    OpenCodeAgentProvider,
    type OpenCodeAgentProviderOptions,
    type OpenCodeProviderInstallerLike,
} from "./OpenCodeAgentProvider.js";
export {
    OpenCodeAgentProcessFactory,
    type OpenCodeAgentProcessStartOptions,
    type OpenCodeAgentRuntimeFactory,
} from "./OpenCodeAgentProcess.js";
export {
    OPENCODE_PACKAGE_NAME,
    OPENCODE_PROVIDER_RUNTIME_DEPENDENCIES,
    OPENCODE_RUNTIME_VERSION,
    OpenCodeProviderInstaller,
    type OpenCodeProviderInstallation,
    type OpenCodeProviderInstallerOptions,
} from "./OpenCodeProviderInstaller.js";

export async function createAgentProvider(): Promise<
    import("../../builtin/provider/AgentProvider.js").AgentProvider
> {
    const { OpenCodeAgentProvider } =
        await import("./OpenCodeAgentProvider.js");
    return new OpenCodeAgentProvider();
}
