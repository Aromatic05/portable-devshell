import assert from "node:assert/strict";
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

test("FrameCodec encodes and decodes a single frame", () => {
    const value = {
        id: "req-1",
        kind: "request",
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
