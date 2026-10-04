import type { WorkerTransportConnection } from "@portable-devshell/core";

export interface ReverseInstancePort {
    name: string;
    provider: "docker" | "local" | "podman" | "reverse" | "ssh";
    reverseConnection?: WorkerTransportConnection;
}

export interface ReverseInstanceLookupPort {
    acquireGeneration(instanceName: string): {
        readonly descriptor: ReverseInstancePort;
        release(): void;
    };
    get(instanceName: string): ReverseInstancePort | undefined;
}
