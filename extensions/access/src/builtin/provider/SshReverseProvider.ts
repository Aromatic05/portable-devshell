import { AccessBinaryManager } from "../binary/AccessBinaryManager.js";
import type { SshAccessEndpoint } from "../Config.js";
import type {
    AccessProvider,
    AccessProviderContext,
    AccessProviderOpenInput,
    AccessProviderSession,
} from "./AccessProvider.js";
import { managedProviderSession } from "./AccessProvider.js";

export class SshReverseProvider implements AccessProvider {
    readonly kind = "ssh" as const;
    readonly #binaries: AccessBinaryManager;
    readonly #context: AccessProviderContext;

    constructor(context: AccessProviderContext, binaries: AccessBinaryManager) {
        this.#binaries = binaries;
        this.#context = context;
    }

    async open(input: AccessProviderOpenInput): Promise<AccessProviderSession> {
        if (input.endpoint.provider !== this.kind)
            throw new TypeError("SshReverseProvider received a non-SSH endpoint.");
        const endpoint: SshAccessEndpoint = input.endpoint;
        const command = await this.#binaries.resolve(this.kind, endpoint.binary);
        const process = await this.#context.processes.start({
            args: buildSshArgs(endpoint, input.target.origin),
            command,
        });
        return managedProviderSession(process, () => endpoint.publicUrl);
    }
}

export function buildSshArgs(endpoint: SshAccessEndpoint, origin: URL): string[] {
    const localHost = sshHost(origin.hostname);
    const remoteHost = sshHost(endpoint.remoteBindHost);
    return [
        "-N",
        "-T",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ServerAliveInterval=30",
        "-o",
        "ServerAliveCountMax=3",
        "-p",
        String(endpoint.port),
        ...(endpoint.identityFile === undefined
            ? []
            : ["-i", endpoint.identityFile]),
        ...(endpoint.options ?? []),
        "-R",
        `${remoteHost}:${endpoint.remotePort}:${localHost}:${origin.port}`,
        endpoint.user === undefined ? endpoint.host : `${endpoint.user}@${endpoint.host}`,
    ];
}

function sshHost(value: string): string {
    if (value.startsWith("[") && value.endsWith("]")) return value;
    return value.includes(":") ? `[${value}]` : value;
}
