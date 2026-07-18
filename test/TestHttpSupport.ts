import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

export function requireTcpPort(address: AddressInfo | string | null | undefined): number {
    assert.notEqual(address, null);
    assert.notEqual(address, undefined);
    assert.equal(typeof address, "object");
    return (address as AddressInfo).port;
}
