export const streamTypes = ["event", "rpc", "stderr", "stdout"] as const;

export type StreamType = (typeof streamTypes)[number];
