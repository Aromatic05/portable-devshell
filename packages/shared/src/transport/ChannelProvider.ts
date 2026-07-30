import type { Socket } from "node:net";

import { Channel } from "./Channel.js";
import { resolveControlSocketPath } from "./ControlEndpoint.js";
import type { FrameChannel } from "./FrameChannel.js";

export interface ChannelProvider {
    connect(): Promise<FrameChannel>;
}

export interface SocketChannelProviderOptions {
    socketFactory?: (path: string) => Socket;
    socketPath?: string;
    xdgRuntimeDir?: string;
}

export class SocketChannelProvider implements ChannelProvider {
    readonly #socketFactory?: (path: string) => Socket;
    readonly #socketPath: string;

    constructor(options: SocketChannelProviderOptions = {}) {
        this.#socketFactory = options.socketFactory;
        this.#socketPath = options.socketPath ?? resolveControlSocketPath(options.xdgRuntimeDir);
    }

    async connect(): Promise<FrameChannel> {
        return await Channel.connect(this.#socketPath, { socketFactory: this.#socketFactory });
    }
}
