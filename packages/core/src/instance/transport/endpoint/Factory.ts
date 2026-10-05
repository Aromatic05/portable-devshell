import { ReverseChannel } from "./channel/reverse/Channel.js";
import { createPortClient, Endpoint, type PortClient, type InstanceContainerConfig } from "@portable-devshell/shared";
import type { TransportConnection } from "./Connection.js";
import { LocalConnection, LocalChannel } from "./channel/Local.js";
import { SshConnection, SshChannel } from "./channel/Ssh.js";
import { DockerConnection, DockerChannel } from "./channel/Docker.js";
import { PodmanConnection, PodmanChannel } from "./channel/Podman.js";
import type { SpawnFunction } from "./channel/worker/Command.js";

export type TransportFactoryOptions =
    | { type: "reverse"; connection: PortClient }
    | { type: "local"; spawnFunction?: SpawnFunction }
    | { type: "ssh"; command: string; spawnFunction?: SpawnFunction }
    | { type: "docker"; container: InstanceContainerConfig; dockerBinary?: string; spawnFunction?: SpawnFunction }
    | { type: "podman"; container: InstanceContainerConfig; podmanBinary?: string; spawnFunction?: SpawnFunction };

export class TransportFactory {
    static createEndpoint(connection: TransportConnection, host: string, workerHost: string): Endpoint {
        const endpoint: Endpoint = new Endpoint({
            host,
            connectChannel: async (signal) => {
                const attached = connection.takeAttached();
                if (attached !== undefined) {
                    const channel = new ReverseChannel(
                        createPortClient(endpoint, workerHost, "core"),
                    );
                    channel.attach(attached);
                    return channel;
                }
                return await connection.connect(signal);
            },
        });
        return endpoint;
    }

    static create(options: Extract<TransportFactoryOptions, { type: "local" }>): LocalChannel;
    static create(options: Extract<TransportFactoryOptions, { type: "ssh" }>): SshChannel;
    static create(options: Extract<TransportFactoryOptions, { type: "docker" }>): DockerChannel;
    static create(options: Extract<TransportFactoryOptions, { type: "podman" }>): PodmanChannel;
    static create(options: Extract<TransportFactoryOptions, { type: "reverse" }>): ReverseChannel;
    static create(options: TransportFactoryOptions): LocalChannel | SshChannel | DockerChannel | PodmanChannel | ReverseChannel {
        switch (options.type) {
            case "reverse": return new ReverseChannel(options.connection);
            case "local": return new LocalConnection(options).channel;
            case "ssh": return new SshConnection(options).channel;
            case "docker": return new DockerConnection({ ...options, binary: options.dockerBinary }).channel;
            case "podman": return new PodmanConnection({ ...options, binary: options.podmanBinary }).channel;
        }
    }
}
