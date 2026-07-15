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

        const [scheme, token] = authorizationHeader.split(/\s+/, 2);
        if (scheme !== "Bearer" || typeof token !== "string" || token.length === 0) {
            return undefined;
        }

        return {
            clientId: `token:${createHash("sha256").update(token).digest("hex")}`,
            scopes: [],
            token
        };
    }
}
