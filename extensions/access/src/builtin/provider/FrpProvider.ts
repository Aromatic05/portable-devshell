import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { AccessBinaryManager } from "../binary/AccessBinaryManager.js";
import type { FrpAccessEndpoint } from "../Config.js";
import type {
    AccessProvider,
    AccessProviderContext,
    AccessProviderOpenInput,
    AccessProviderSession,
} from "./AccessProvider.js";
import { managedProviderSession } from "./AccessProvider.js";

export class FrpProvider implements AccessProvider {
    readonly kind = "frp" as const;
    readonly #binaries: AccessBinaryManager;
    readonly #context: AccessProviderContext;

    constructor(context: AccessProviderContext, binaries: AccessBinaryManager) {
        this.#binaries = binaries;
        this.#context = context;
    }

    async open(input: AccessProviderOpenInput): Promise<AccessProviderSession> {
        if (input.endpoint.provider !== this.kind)
            throw new TypeError("FrpProvider received a non-FRP endpoint.");
        const endpoint: FrpAccessEndpoint = input.endpoint;
        const command = await this.#binaries.resolve(this.kind, endpoint.binary);
        await mkdir(this.#context.runtimeDirectory, { mode: 0o700, recursive: true });
        const configFile = join(
            this.#context.runtimeDirectory,
            `frpc-${endpoint.id}.toml`,
        );
        await writeFile(configFile, renderFrpConfig(endpoint, input.target.origin), {
            mode: 0o600,
        });
        const process = await this.#context.processes.start({
            args: ["-c", configFile, ...(endpoint.arguments ?? [])],
            command,
        });
        return managedProviderSession(process, () => endpoint.publicUrl);
    }
}

export function renderFrpConfig(
    endpoint: FrpAccessEndpoint,
    origin: URL,
): string {
    const host = stripIpv6Brackets(origin.hostname);
    const port = Number(origin.port);
    const lines = [
        `serverAddr = ${tomlString(endpoint.serverHost)}`,
        `serverPort = ${endpoint.serverPort}`,
    ];
    if (endpoint.token !== undefined) {
        lines.push('auth.method = "token"', `auth.token = ${tomlString(endpoint.token)}`);
    }
    lines.push(
        "",
        "[[proxies]]",
        `name = ${tomlString(`devshell-${endpoint.id}`)}`,
        'type = "tcp"',
        `localIP = ${tomlString(host)}`,
        `localPort = ${port}`,
        `remotePort = ${endpoint.remotePort}`,
        "",
    );
    return lines.join("\n");
}

function tomlString(value: string): string {
    return JSON.stringify(value);
}

function stripIpv6Brackets(value: string): string {
    return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}
