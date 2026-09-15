import assert from "node:assert/strict";
import test from "node:test";
import { parseContextMessageDirective } from "@portable-devshell/shared";

test("Context message directives are explicit leading text markers", () => {
    assert.deepEqual(parseContextMessageDirective("#push answer first"), {
        body: "answer first",
        directive: "push",
    });
    assert.deepEqual(parseContextMessageDirective("  #stop\nStop now"), {
        body: "Stop now",
        directive: "stop",
    });
    assert.deepEqual(parseContextMessageDirective("#resume"), {
        body: "",
        directive: "resume",
    });
    assert.deepEqual(
        parseContextMessageDirective("Please mention #stop in the docs"),
        { body: "Please mention #stop in the docs" },
    );
});
