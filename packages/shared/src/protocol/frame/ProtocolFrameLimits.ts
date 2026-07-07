export const FRAME_HEADER_SIZE = 4;
export const MAX_FRAME_SIZE = 16 * 1024 * 1024;

export const ProtocolLimits = {
    FRAME_HEADER_SIZE,
    MAX_FRAME_SIZE
} as const;
