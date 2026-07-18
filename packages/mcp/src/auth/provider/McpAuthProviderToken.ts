import { createHash, timingSafeEqual } from "node:crypto";

import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

export class McpAuthProviderToken {
    readonly #expectedDigest: Buffer;

    constructor(expectedToken: string) {
        this.#expectedDigest = digest(expectedToken);
    }

    authorize(authorizationHeader: string | undefined): boolean {
        return this.authenticate(authorizationHeader) !== undefined;
    }

    authenticate(authorizationHeader: string | undefined): AuthInfo | undefined {
        if (authorizationHeader === undefined) {
            return undefined;
        }

        const match = /^Bearer[ \t]+([^ \t]+)$/iu.exec(authorizationHeader);
        if (match === null) {
            return undefined;
        }
        const token = match[1]!;
        const tokenDigest = digest(token);
        if (!timingSafeEqual(this.#expectedDigest, tokenDigest)) {
            return undefined;
        }

        return {
            clientId: `token:${tokenDigest.toString("hex")}`,
            scopes: [],
            token
        };
    }
}

function digest(token: string): Buffer {
    return createHash("sha256").update(token).digest();
}
