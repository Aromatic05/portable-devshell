import type { ExtensionManagedProcess } from "@portable-devshell/extension";

import { AccessBinaryManager } from "../binary/AccessBinaryManager.js";
import type { CloudflaredAccessEndpoint } from "../Config.js";
import type {
    AccessProvider,
    AccessProviderContext,
    AccessProviderOpenInput,
    AccessProviderSession,
} from "./AccessProvider.js";

const quickTunnelUrl = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/iu;

export class CloudflaredProvider implements AccessProvider {
    readonly kind = "cloudflared" as const;
    readonly #binaries: AccessBinaryManager;
    readonly #context: AccessProviderContext;

    constructor(context: AccessProviderContext, binaries: AccessBinaryManager) {
        this.#binaries = binaries;
        this.#context = context;
    }

    async open(input: AccessProviderOpenInput): Promise<AccessProviderSession> {
        if (input.endpoint.provider !== this.kind)
            throw new TypeError("CloudflaredProvider received a non-cloudflared endpoint.");
        const endpoint: CloudflaredAccessEndpoint = input.endpoint;
        const command = await this.#binaries.resolve(this.kind, endpoint.binary);
        const process = await this.#context.processes.start({
            args: [
                "tunnel",
                "--no-autoupdate",
                "--url",
                input.target.origin.href,
                ...(endpoint.arguments ?? []),
            ],
            command,
        });
        let publicUrl: string | undefined;
        let outputTail = "";
        const accept = (chunk: string) => {
            outputTail = `${outputTail}${chunk}`.slice(-4096);
            const matched = quickTunnelUrl.exec(outputTail)?.[0];
            if (matched !== undefined) publicUrl = matched;
        };
        const removeStdout = process.onStdout(accept);
        const removeStderr = process.onStderr(accept);
        return session(process, () => publicUrl, () => {
            removeStdout();
            removeStderr();
        });
    }
}

function session(
    process: ExtensionManagedProcess,
    publicUrl: () => string | undefined,
    cleanup: () => void,
): AccessProviderSession {
    let cleaned = false;
    const release = () => {
        if (cleaned) return;
        cleaned = true;
        cleanup();
    };
    void process.closed.finally(release);
    return Object.freeze({
        closed: process.closed.then(() => undefined),
        process,
        publicUrl,
        stop: async () => {
            try {
                await process.terminate();
                await process.closed;
            } finally {
                release();
            }
        },
    });
}
