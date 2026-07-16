import assert from "node:assert/strict";
import test from "node:test";

import {
    ControlError,
    isControlErrorBody,
    toControlErrorBody
} from "@portable-devshell/shared";

test("control error serializes nested control errors and structured details", () => {
    const cause = new ControlError({
        code: "worker.offline",
        details: { instance: "local-one" },
        message: "worker offline",
        retryable: true
    });
    const error = new ControlError({
        cause,
        code: "control.failed",
        details: { operation: "start" },
        message: "control failed",
        retryable: false
    });

    assert.deepEqual(error.toBody(), {
        cause: {
            code: "worker.offline",
            details: { instance: "local-one" },
            message: "worker offline",
            retryable: true
        },
        code: "control.failed",
        details: { operation: "start" },
        message: "control failed",
        retryable: false
    });
    assert.equal(error.cause, cause);
});

test("control error body validation recursively rejects malformed causes", () => {
    assert.equal(
        isControlErrorBody({
            cause: {
                code: "worker.offline",
                message: "offline",
                retryable: true
            },
            code: "control.failed",
            message: "failed",
            retryable: false
        }),
        true
    );

    for (const value of [
        null,
        [],
        { code: 1, message: "failed", retryable: false },
        { code: "failed", message: 1, retryable: false },
        { code: "failed", message: "failed", retryable: "no" },
        {
            cause: { code: "nested", message: "nested", retryable: "no" },
            code: "failed",
            message: "failed",
            retryable: false
        }
    ]) {
        assert.equal(isControlErrorBody(value), false);
    }
});

test("plain errors are normalized with defaults and nested causes", () => {
    const cause = Object.assign(new Error("root cause"), {
        code: "root.failed",
        retryable: true
    });
    const error = Object.assign(new Error("outer failure", { cause }), {
        details: { operation: "status" }
    });

    assert.deepEqual(toControlErrorBody(error), {
        cause: {
            code: "root.failed",
            message: "root cause",
            retryable: true
        },
        code: "error.unknown",
        details: { operation: "status" },
        message: "outer failure",
        retryable: false
    });
});

test("existing control error bodies pass through and unrelated values are ignored", () => {
    const body = {
        code: "control.failed",
        message: "failed",
        retryable: false
    };

    assert.equal(toControlErrorBody(body), body);
    assert.equal(toControlErrorBody(undefined), undefined);
    assert.equal(toControlErrorBody("failed"), undefined);
    assert.equal(toControlErrorBody({ code: "failed" }), undefined);
});
