import type { FrameChannel } from "./FrameChannel.js";

export interface ChannelProvider {
    connect(signal?: AbortSignal): Promise<FrameChannel>;
}
