import type { WorkerInstance, WorkerRpcInboundConnector } from "@portable-devshell/core";

export interface ReverseInstancePort {
    name: string;
    provider: "docker" | "local" | "podman" | "reverse" | "ssh";
    reverseConnector?: WorkerRpcInboundConnector;
    worker: Pick<WorkerInstance, "acceptReverseChannel" | "setReverseEnrollmentState" | "snapshot">;
}

export interface ReverseInstanceLookupPort {
    get(instanceName: string): ReverseInstancePort | undefined;
}
