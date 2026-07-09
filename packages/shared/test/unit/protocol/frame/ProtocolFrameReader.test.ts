import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

const { ControlError, FrameCodec, FrameReader, FrameWriter, MAX_FRAME_SIZE } = await import("@portable-devshell/shared");

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
        type: "request"
    });

    assert.deepEqual(reader.push(frame.subarray(0, 2)), []);
    assert.deepEqual(reader.push(frame.subarray(2, 5)), []);
    assert.deepEqual(reader.push(frame.subarray(5)), [
        {
            id: "req-1",
            type: "request"
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
        type: "response"
    });

    const frame = Buffer.concat(chunks);

    assert.deepEqual(FrameCodec.decode(frame), {
        id: "req-1",
        type: "response"
    });
});
