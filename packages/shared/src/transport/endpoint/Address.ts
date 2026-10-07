export type Host = string;
export type PortName = string;

export interface Address {
    readonly host: Host;
    readonly port: PortName;
}

/** Minimal secure-random surface required to create a transport id. */
export interface TransportIdRandomSource {
    randomUUID?(): string;
    getRandomValues?<T extends ArrayBufferView>(array: T): T;
}

const TRANSPORT_ID_RANDOM_ERROR =
    "A cryptographically secure random source is required to create a transport id.";

/**
 * Creates an RFC 4122 v4 transport id.
 *
 * `crypto.randomUUID` is gated behind secure browser contexts and is missing on
 * plain HTTP origins, so this prefers it and otherwise derives a v4 UUID from
 * `crypto.getRandomValues`, which is available in non-secure contexts. Fails
 * closed when neither secure source exists.
 */
export function createTransportId(
    source: TransportIdRandomSource | null | undefined = globalThis.crypto,
): string {
    if (source === null || source === undefined)
        throw new Error(TRANSPORT_ID_RANDOM_ERROR);
    if (typeof source.randomUUID === "function") return source.randomUUID();
    if (typeof source.getRandomValues !== "function")
        throw new Error(TRANSPORT_ID_RANDOM_ERROR);
    const bytes = new Uint8Array(16);
    source.getRandomValues(bytes);
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) =>
        byte.toString(16).padStart(2, "0"),
    ).join("");
    return (
        hex.slice(0, 8) +
        "-" +
        hex.slice(8, 12) +
        "-" +
        hex.slice(12, 16) +
        "-" +
        hex.slice(16, 20) +
        "-" +
        hex.slice(20)
    );
}
