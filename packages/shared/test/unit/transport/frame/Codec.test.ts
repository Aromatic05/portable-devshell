import assert from "node:assert/strict";
import test from "node:test";

import {
    FRAME_MAX_DATA_SIZE,
    FRAME_MAX_OPEN_METADATA_SIZE,
    FRAME_MAX_OPEN_SERVICE_SIZE,
    FrameBuffer,
    decodeFrame,
    encodeFrame,
    encodePacket,
    type Frame,
} from "@portable-devshell/shared/transport/frame";

function hex(value: Uint8Array): string {
    return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join(
        "",
    );
}

test("Frame v1 encodes stable OPEN DATA WINDOW FIN and RESET wire vectors", () => {
    const frames: Array<[Frame, string]> = [
        [
            {
                type: "open",
                streamId: 1,
                receiveWindow: 256,
                service: "network.tcp",
                metadata: Uint8Array.from([0xaa, 0xbb]),
            },
            "0000001901010000000100000100000b6e6574776f726b2e746370aabb",
        ],
        [
            {
                type: "data",
                streamId: 2,
                data: new TextEncoder().encode("abc"),
            },
            "00000009010200000002616263",
        ],
        [
            { type: "window", streamId: 3, creditDelta: 65_536 },
            "0000000a01030000000300010000",
        ],
        [{ type: "fin", streamId: 4 }, "00000006010400000004"],
        [
            { type: "reset", streamId: 5, code: 4, message: "stop" },
            "0000000c010500000005000473746f70",
        ],
    ];

    for (const [frame, expected] of frames) {
        const encoded = encodeFrame(frame);
        assert.equal(hex(encoded), expected);
        assert.deepEqual(decodeFrame(encoded), frame);
    }
});

test("FrameBuffer restores split and coalesced Frame boundaries", () => {
    const first = encodeFrame({
        type: "data",
        streamId: 1,
        data: new TextEncoder().encode("one"),
    });
    const second = encodeFrame({
        type: "fin",
        streamId: 1,
    });
    const joined = new Uint8Array(first.byteLength + second.byteLength);
    joined.set(first, 0);
    joined.set(second, first.byteLength);

    const buffer = new FrameBuffer();
    assert.deepEqual(buffer.push(joined.subarray(0, 3)), []);
    assert.deepEqual(buffer.push(joined.subarray(3, first.byteLength - 1)), []);
    assert.deepEqual(buffer.push(joined.subarray(first.byteLength - 1)), [
        {
            type: "data",
            streamId: 1,
            data: new TextEncoder().encode("one"),
        },
        { type: "fin", streamId: 1 },
    ]);
});

test("FrameBuffer restores a highly fragmented packet without repeated-prefix assumptions", () => {
    const expected = new Uint8Array(4096);
    for (let index = 0; index < expected.byteLength; index += 1)
        expected[index] = index & 0xff;
    const encoded = encodeFrame({
        type: "data",
        streamId: 9,
        data: expected,
    });
    const buffer = new FrameBuffer();
    const frames: Frame[] = [];
    for (let index = 0; index < encoded.byteLength; index += 1)
        frames.push(...buffer.push(encoded.subarray(index, index + 1)));

    assert.deepEqual(frames, [
        {
            type: "data",
            streamId: 9,
            data: expected,
        },
    ]);
    assert.equal(buffer.empty, true);
});

test("Frame v1 rejects malformed headers, reserved ids and invalid flow-control fields", () => {
    const data = encodeFrame({
        type: "data",
        streamId: 1,
        data: Uint8Array.of(1),
    });

    const version = Uint8Array.from(data);
    version[4] = 2;
    assert.throws(() => decodeFrame(version), /version/iu);

    const type = Uint8Array.from(data);
    type[5] = 0xff;
    assert.throws(() => decodeFrame(type), /type/iu);

    const reserved = Uint8Array.from(data);
    reserved.fill(0, 6, 10);
    assert.throws(() => decodeFrame(reserved), /stream/iu);

    assert.throws(
        () => encodeFrame({ type: "window", streamId: 1, creditDelta: 0 }),
        /credit/iu,
    );
    assert.throws(
        () =>
            encodeFrame({
                type: "data",
                streamId: 1,
                data: new Uint8Array(FRAME_MAX_DATA_SIZE + 1),
            }),
        /data|payload|large/iu,
    );
});

test("Frame v1 keeps Service metadata opaque while validating the Service name", () => {
    const metadata = Uint8Array.from([0, 255, 1, 254]);
    const frame: Frame = {
        type: "open",
        streamId: 7,
        receiveWindow: 1024,
        service: "process.exec",
        metadata,
    };
    assert.deepEqual(decodeFrame(encodeFrame(frame)), frame);
    assert.throws(
        () =>
            encodeFrame({
                ...frame,
                service: "",
            }),
        /service/iu,
    );
    assert.throws(
        () =>
            encodeFrame({
                ...frame,
                service: "s".repeat(FRAME_MAX_OPEN_SERVICE_SIZE + 1),
            }),
        /service/iu,
    );
    assert.throws(
        () =>
            encodeFrame({
                ...frame,
                metadata: new Uint8Array(FRAME_MAX_OPEN_METADATA_SIZE + 1),
            }),
        /metadata|large/iu,
    );

    const body = new Uint8Array(
        6 + 6 + 1 + FRAME_MAX_OPEN_METADATA_SIZE + 1,
    );
    body[0] = 1;
    body[1] = 1;
    const view = new DataView(body.buffer);
    view.setUint32(2, 9, false);
    view.setUint32(6, 1024, false);
    view.setUint16(10, 1, false);
    body[12] = "x".charCodeAt(0);
    assert.throws(
        () => decodeFrame(encodePacket(body)),
        /metadata|large/iu,
    );
});
