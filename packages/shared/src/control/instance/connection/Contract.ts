// Reverse-enrollment wire contract. These are Control-plane operations even
// though they describe an instance's reverse connection.

import type { ReverseDeviceCodeResult } from "./Model.js";

export const reverseOperations = {
    createCode: "createCode",
    revokeToken: "revokeToken",
    rotateToken: "rotateToken",
} as const;

export interface ReverseContract {
    createCode: {
        request: { instance: string };
        response: ReverseDeviceCodeResult;
    };
    revokeToken: {
        request: { instance: string };
        response: { instance: string; revoked: true };
    };
    rotateToken: {
        request: { instance: string };
        response: { deviceToken: string; instance: string };
    };
}

export type ReverseOperation = keyof ReverseContract;

export type ReverseRequest<Operation extends ReverseOperation> =
    ReverseContract[Operation]["request"];

export type ReverseResponse<Operation extends ReverseOperation> =
    ReverseContract[Operation]["response"];
