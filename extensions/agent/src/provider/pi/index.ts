export {
    PI_PROVIDER_ID,
    PI_PROVIDER_VERSION,
    PiAgentProvider,
    type PiAgentProviderOptions,
    type PiProviderInstallerLike
} from "./PiAgentProvider.js";
export {
    PiAgentProcessFactory,
    type PiAgentProcessStartOptions,
    type PiAgentRuntimeFactory
} from "./PiAgentProcess.js";
export {
    PI_BOOTSTRAP_VERSION,
    PI_PACKAGE_NAME,
    PiProviderInstaller,
    type PiProviderInstallation,
    type PiProviderInstallerOptions,
    type PiProviderPackageResolver
} from "./PiProviderInstaller.js";

export async function createAgentProvider(): Promise<import("../../builtin/provider/AgentProvider.js").AgentProvider> {
    const { PiAgentProvider } = await import("./PiAgentProvider.js");
    return new PiAgentProvider();
}
