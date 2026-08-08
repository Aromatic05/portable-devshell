import assert from "node:assert/strict";
import test from "node:test";

import { createCursorPositionResponder } from "../TerminalProtocolTestSupport.ts";

test("terminal test responder answers every complete cursor position query including split input", async () => {
    const responses: string[] = [];
    const responder = createCursorPositionResponder(async (response) => {
        responses.push(response);
    });

    assert.equal(await responder.consume("prompt\u001B[6"), 0);
    assert.equal(await responder.consume("nmore\u001B[6n"), 2);
    assert.equal(await responder.consume("ordinary output"), 0);
    assert.deepEqual(responses, ["\u001B[1;1R", "\u001B[1;1R"]);
});
