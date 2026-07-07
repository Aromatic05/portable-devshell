import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

const isDistTest = import.meta.url.includes("/dist/");
const moduleBaseUrl = isDistTest
    ? new URL("./", import.meta.url)
    : new URL("../../dist/protocol/", import.meta.url);
const errorBaseUrl = isDistTest
    ? new URL("../errors/", import.meta.url)
    : new URL("../../dist/errors/", import.meta.url);

const { ControlError } = await import(
    new URL("ControlError.js", errorBaseUrl).href
);
const { FrameCodec } = await import(
    new URL("FrameCodec.js", moduleBaseUrl).href
);
const { FrameReader } = await import(
    new URL("FrameReader.js", moduleBaseUrl).href
);
const { FrameWriter } = await import(
    new URL("FrameWriter.js", moduleBaseUrl).href
);
const { MAX_FRAME_SIZE } = await import(
    new URL("ProtocolLimits.js", moduleBaseUrl).href
);

function readErrorCode(error: unknown): string | undefined {
    if (typeof error !== "object" || error === null || !("code" in error)) {
        return undefined;
    }

    const { code } = error as { code?: unknown };
    return typeof code === "string" ? code : undefined;
}

test("FrameReader assembles a frame from partial chunks", () => {
    const reader = new FrameReader();
    const frame = FrameCodec.encode({
        id: "req-1",
        kind: "request"
    });

    assert.deepEqual(reader.push(frame.subarray(0, 2)), []);
    assert.deepEqual(reader.push(frame.subarray(2, 5)), []);
    assert.deepEqual(reader.push(frame.subarray(5)), [
        {
            id: "req-1",
            kind: "request"
        }
    ]);
    assert.equal(reader.bufferedByteLength, 0);
});

test("FrameReader splits sticky frames from one chunk", () => {
    const reader = new FrameReader();
    const first = FrameCodec.encode({
        id: "req-1"
    });
    const second = FrameCodec.encode({
        id: "req-2"
    });

    const frames = reader.push(Buffer.concat([first, second]));

    assert.deepEqual(frames, [
        {
            id: "req-1"
        },
        {
            id: "req-2"
        }
    ]);
    assert.equal(reader.bufferedByteLength, 0);
});

test("FrameReader rejects oversized frame headers", () => {
    const reader = new FrameReader();
    const header = Buffer.alloc(4);
    header.writeUInt32BE(MAX_FRAME_SIZE + 1, 0);

    assert.throws(
        () => reader.push(header),
        (error: unknown) => {
            if (!(error instanceof ControlError)) {
                return false;
            }

            assert.equal(readErrorCode(error), "protocol.frameTooLarge");
            return true;
        }
    );
});

test("FrameWriter writes a length-prefixed JSON frame to a writable stream", async () => {
    const stream = new PassThrough();
    const writer = new FrameWriter(stream);
    const chunks: Buffer[] = [];

    stream.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
    });

    await writer.write({
        id: "req-1",
        kind: "response"
    });

    const frame = Buffer.concat(chunks);

    assert.deepEqual(FrameCodec.decode(frame), {
        id: "req-1",
        kind: "response"
    });
});
