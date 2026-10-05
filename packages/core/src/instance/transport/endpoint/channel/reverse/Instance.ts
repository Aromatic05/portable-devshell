import type { TransportConnection } from "../../Connection.js";

export interface ReverseInstance {
    name: string;
    provider: "docker" | "local" | "podman" | "reverse" | "ssh";
    reverseConnection?: TransportConnection;
}

export interface ReverseInstanceHandle extends ReverseInstance {
    acquireLease(): {
        readonly instance: ReverseInstance;
        release(): void;
    };
}

export interface ReverseInstanceLookup {
    get(instanceName: string): ReverseInstanceHandle | undefined;
}
