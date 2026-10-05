import type { TransportConnection } from "../../Connection.js";

export interface ReverseInstance {
    name: string;
    provider: "docker" | "local" | "podman" | "reverse" | "ssh";
    reverseConnection?: TransportConnection;
}

export interface ReverseInstanceLookup {
    acquireGeneration(instanceName: string): {
        readonly descriptor: ReverseInstance;
        release(): void;
    };
    get(instanceName: string): ReverseInstance | undefined;
}
