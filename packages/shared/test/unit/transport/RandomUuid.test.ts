import assert from "node:assert/strict";
import test from "node:test";

import { randomUuid } from "../../../src/transport/RandomUuid.ts";

test("randomUuid prefers the platform randomUUID implementation", () => {
    assert.equal(
        randomUuid({
            getRandomValues(array) {
                return array;
            },
            randomUUID: () => "11111111-2222-4333-8444-555555555555"
        }),
        "11111111-2222-4333-8444-555555555555"
    );
});

test("randomUuid uses getRandomValues when randomUUID is unavailable", () => {
    const uuid = randomUuid({
        getRandomValues(array) {
            const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
            for (let index = 0; index < bytes.length; index += 1) {
                bytes[index] = index;
            }
            return array;
        }
    });

    assert.equal(uuid, "00010203-0405-4607-8809-0a0b0c0d0e0f");
    assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
});

test("randomUuid refuses an insecure non-cryptographic fallback", () => {
    assert.throws(
        () => randomUuid(null),
        /cryptographically secure random source/u
    );
});
