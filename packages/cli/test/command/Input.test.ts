import assert from "node:assert/strict";
import { once } from "node:events";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";
import { readCommandLine } from "../../src/command/Input.js";

test("prompt reads preserve pasted remainder without closing the shared input", async () => {
    const input = new PassThrough();
    let closes = 0;
    input.on("close", () => {
        closes += 1;
    });
    input.write("first\r\nsecond\n");
    assert.equal(await readCommandLine(input), "first\r");
    assert.equal(await readCommandLine(input), "second");
    assert.equal(input.destroyed, false);
    assert.equal(closes, 0);
    assert.equal(input.listenerCount("readable"), 0);
    const closed = once(input, "close");
    input.end();
    assert.equal(await readCommandLine(input), "");
    await closed;
    assert.equal(closes, 1);
    assert.equal(await readCommandLine(input), "");
});

test("prompt EOF preserves an unterminated UTF-8 answer across chunks", async () => {
    const bytes = Buffer.from("网关");
    const input = Readable.from([bytes.subarray(0, 1), bytes.subarray(1)]);
    assert.equal(await readCommandLine(input), "网关");
    assert.equal(await readCommandLine(input), "");
});
