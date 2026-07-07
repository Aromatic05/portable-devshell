import { randomUUID } from "node:crypto";

export class RequestId {
    static create(value: string): string {
        if (!this.is(value)) {
            throw new TypeError("RequestId must be a non-empty string.");
        }

        return value;
    }

    static generate(): string {
        return randomUUID();
    }

    static is(value: unknown): value is string {
        return typeof value === "string" && value.length > 0;
    }
}
