import assert from "node:assert/strict";
import test from "node:test";

const { ControlError, FrameCodec, MAX_FRAME_SIZE } = await import("@portable-devshell/shared");

function readErrorCode(error: unknown): string | undefined {
    if (typeof error !== "object" || error === null || !("code" in error)) {
        return undefined;
    }

    const { code } = error as { code?: unknown };
    return typeof code === "string" ? code : undefined;
}

test("FrameCodec encodes and decodes a single frame", () => {
    const value = {
        id: "req-1",
        type: "request",
        params: {
            ok: true
        }
    };

    const frame = FrameCodec.encode(value);

    assert.equal(frame.readUInt32BE(0), Buffer.byteLength(JSON.stringify(value)));
    assert.deepEqual(FrameCodec.decode(frame), value);
});

test("FrameCodec rejects payloads larger than MAX_FRAME_SIZE", () => {
    assert.throws(
        () => FrameCodec.encodePayload(Buffer.alloc(MAX_FRAME_SIZE + 1)),
        (error: unknown) => {
            if (!(error instanceof ControlError)) {
                return false;
            }

            assert.equal(readErrorCode(error), "protocol.frameTooLarge");
            return true;
        }
    );
});

test("FrameCodec rejects invalid JSON payloads", () => {
    const frame = FrameCodec.encodePayload(Buffer.from("{", "utf8"));

    assert.throws(
        () => FrameCodec.decode(frame),
        (error: unknown) => {
            if (!(error instanceof ControlError)) {
                return false;
            }

            assert.equal(readErrorCode(error), "protocol.invalidJson");
            return true;
        }
    );
});

test("FrameCodec rejects empty payloads", () => {
    assert.throws(
        () => FrameCodec.decode(Buffer.from([0, 0, 0, 0])),
        (error: unknown) => {
            if (!(error instanceof ControlError)) {
                return false;
            }

            assert.equal(readErrorCode(error), "protocol.invalidJson");
            return true;
        }
    );
});

test("FrameCodec rejects frames with invalid lengths", () => {
    const frame = Buffer.from([0, 0, 0, 3, 0x7b, 0x7d]);

    assert.throws(
        () => FrameCodec.decode(frame),
        (error: unknown) => {
            if (!(error instanceof ControlError)) {
                return false;
            }

            assert.equal(readErrorCode(error), "protocol.invalidFrame");
            return true;
        }
    );
});
