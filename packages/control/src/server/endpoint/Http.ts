import { createServer } from "node:net";

import type { ControlConfig } from "@portable-devshell/shared";

interface BindEndpoint {
    listenHost: string;
    listenPort: number;
}

export class HttpEndpointPreflight {
    async assertAvailable(previous: ControlConfig, next: ControlConfig): Promise<void> {
        const active = new Set([
            ...(previous.mcp.enabled ? [endpointId(previous.mcp)] : []),
            ...(previous.web.enabled ? [endpointId(previous.web)] : [])
        ]);
        const checked = new Set<string>();
        for (const endpoint of [
            ...(next.mcp.enabled ? [next.mcp] : []),
            ...(next.web.enabled ? [next.web] : [])
        ]) {
            const id = endpointId(endpoint);
            if (active.has(id) || checked.has(id)) continue;
            checked.add(id);
            await assertBindable(endpoint);
        }
    }
}

async function assertBindable(endpoint: BindEndpoint): Promise<void> {
    const server = createServer();
    try {
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(endpoint.listenPort, endpoint.listenHost, () => resolve());
        });
    } catch (error) {
        throw new Error(`Cannot bind HTTP listener ${endpointId(endpoint)}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
        if (server.listening) {
            await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
        }
    }
}

function endpointId(endpoint: BindEndpoint): string {
    return `${endpoint.listenHost}:${endpoint.listenPort}`;
}
