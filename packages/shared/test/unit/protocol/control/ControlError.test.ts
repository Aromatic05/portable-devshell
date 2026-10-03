import assert from "node:assert/strict";
import test from "node:test";

import {
    isRemoteErrorBody,
    RemoteError,
    toRemoteErrorBody,
} from "@portable-devshell/shared";

test("remote error serializes nested causes and structured details", () => {
    const cause = new RemoteError({
        code: "worker.offline",
        details: { instance: "local-one" },
        message: "worker offline",
        retryable: true,
    });
    const error = new RemoteError({
        cause,
        code: "control.failed",
        details: { operation: "start" },
        message: "control failed",
        retryable: false,
    });

    assert.deepEqual(error.toBody(), {
        cause: {
            code: "worker.offline",
            details: { instance: "local-one" },
            message: "worker offline",
            retryable: true,
        },
        code: "control.failed",
        details: { operation: "start" },
        message: "control failed",
        retryable: false,
    });
    assert.equal(error.cause, cause);
});

test("remote error body validation recursively rejects malformed causes", () => {
    assert.equal(
        isRemoteErrorBody({
            cause: {
                code: "worker.offline",
                message: "offline",
                retryable: true,
            },
            code: "control.failed",
            message: "failed",
            retryable: false,
        }),
        true,
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
            retryable: false,
        },
    ]) {
        assert.equal(isRemoteErrorBody(value), false);
    }
});

test("plain errors are normalized with defaults and nested causes", () => {
    const cause = Object.assign(new Error("root cause"), {
        code: "root.failed",
        retryable: true,
    });
    const error = Object.assign(new Error("outer failure", { cause }), {
        details: { operation: "status" },
    });

    assert.deepEqual(toRemoteErrorBody(error), {
        cause: {
            code: "root.failed",
            message: "root cause",
            retryable: true,
        },
        code: "error.unknown",
        details: { operation: "status" },
        message: "outer failure",
        retryable: false,
    });
});

test("existing remote error bodies pass through and unrelated values are ignored", () => {
    const body = {
        code: "control.failed",
        message: "failed",
        retryable: false,
    };

    assert.equal(toRemoteErrorBody(body), body);
    assert.equal(toRemoteErrorBody(undefined), undefined);
    assert.equal(toRemoteErrorBody("failed"), undefined);
    assert.equal(toRemoteErrorBody({ code: "failed" }), undefined);
});
