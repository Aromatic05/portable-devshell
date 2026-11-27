/** Length-prefixed records; frame bytes never enter the JSON payload. */
export const WireKind = { message: 0, frame: 1 } as const;
const HEADER = 5;
const MAX_RECORD = 8 * 1024 * 1024;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface WireRecord {
    kind: number;
    data: Uint8Array;
}

export function encodeRecord(kind: number, data: Uint8Array): Uint8Array {
    if (data.length > MAX_RECORD) throw new RangeError("Browser record is too large.");
    const packet = new Uint8Array(HEADER + data.length);
    packet[0] = kind;
    new DataView(packet.buffer).setUint32(1, data.length);
    packet.set(data, HEADER);
    return packet;
}

export function encodeMessage(value: unknown): Uint8Array {
    return encodeRecord(WireKind.message, textEncoder.encode(JSON.stringify(value)));
}

export function decodeMessage(record: WireRecord): unknown {
    return JSON.parse(textDecoder.decode(record.data));
}

export function encodeFrame(width: number, height: number, jpeg: Uint8Array): Uint8Array {
    const data = new Uint8Array(8 + jpeg.length);
    const view = new DataView(data.buffer);
    view.setUint32(0, width);
    view.setUint32(4, height);
    data.set(jpeg, 8);
    return encodeRecord(WireKind.frame, data);
}

export function decodeFrame(data: Uint8Array) {
    if (data.length < 8) throw new Error("Incomplete browser frame.");
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return { width: view.getUint32(0), height: view.getUint32(4), jpeg: data.subarray(8) };
}

export class WireDecoder {
    #rest: Uint8Array = new Uint8Array(0);

    push(chunk: Uint8Array): WireRecord[] {
        const bytes = new Uint8Array(this.#rest.length + chunk.length);
        bytes.set(this.#rest);
        bytes.set(chunk, this.#rest.length);
        const records: WireRecord[] = [];
        let offset = 0;
        while (bytes.length - offset >= HEADER) {
            const length = new DataView(bytes.buffer, offset, HEADER).getUint32(1);
            if (length > MAX_RECORD) throw new RangeError("Browser record is too large.");
            const end = offset + HEADER + length;
            if (end > bytes.length) break;
            records.push({ kind: bytes[offset]!, data: bytes.subarray(offset + HEADER, end) });
            offset = end;
        }
        this.#rest = bytes.subarray(offset);
        return records;
    }
}
