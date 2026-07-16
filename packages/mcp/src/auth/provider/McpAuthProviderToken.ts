import { createHash } from "node:crypto";

import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

export class McpAuthProviderToken {
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

        return {
            clientId: `token:${createHash("sha256").update(token).digest("hex")}`,
            scopes: [],
            token
        };
    }
}
