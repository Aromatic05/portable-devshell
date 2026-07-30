import type { FrameChannel } from "./FrameChannel.js";

export interface ChannelProvider {
    connect(): Promise<FrameChannel>;
}
