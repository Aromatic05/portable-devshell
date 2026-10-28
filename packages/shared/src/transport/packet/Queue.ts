// Per logical consumer, independent of the shared Frame receive window.
// Bytes count raw binary payloads or the UTF-8 JSON representation of messages;
// the count bound also caps empty messages and object/queue overhead.
export const STREAM_QUEUE_MAX_BYTES = 8 * 1024 * 1024;
export const STREAM_QUEUE_MAX_MESSAGES = 4096;

const encoder = new TextEncoder();

export function streamMessageBytes(message: unknown): number {
    const json = JSON.stringify(message);
    return json === undefined ? 0 : encoder.encode(json).byteLength;
}
