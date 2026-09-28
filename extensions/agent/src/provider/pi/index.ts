export {
    PI_PROVIDER_ID,
    PI_PROVIDER_VERSION,
    PiAgentProvider,
    type PiAgentProviderOptions,
    type PiProviderInstallerLike,
} from "./runtime/Provider.js";
export {
    PiAgentProcessFactory,
    type PiAgentProcessStartOptions,
    type PiAgentRuntimeFactory,
} from "./runtime/AgentProcess.js";
export {
    PI_BOOTSTRAP_VERSION,
    PI_PACKAGE_NAME,
    PI_PROVIDER_RUNTIME_DEPENDENCIES,
    PiProviderInstaller,
    hasManagedPiInstallation,
    removeManagedPiInstallation,
    type PiProviderInstallation,
    type PiProviderInstallerOptions,
} from "./install/ProviderInstaller.js";

export async function createAgentProvider(): Promise<
    import("../../builtin/provider/AgentProvider.js").AgentProvider
> {
    const { PiAgentProvider } = await import("./runtime/Provider.js");
    return new PiAgentProvider();
}
