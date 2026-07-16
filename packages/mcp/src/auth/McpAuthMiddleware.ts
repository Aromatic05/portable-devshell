import type { IncomingMessage, ServerResponse } from "node:http";

import type { McpAuthConfig } from "./McpAuthConfig.js";
import { McpAuthProviderNone } from "./provider/McpAuthProviderNone.js";
import { McpAuthProviderToken } from "./provider/McpAuthProviderToken.js";

export class McpAuthMiddleware {
    readonly #noneProvider = new McpAuthProviderNone();
    readonly #tokenProvider = new McpAuthProviderToken();

    authorize(request: IncomingMessage, response: ServerResponse, config: McpAuthConfig | undefined): boolean {
        if (config?.enabled !== true) {
            this.#noneProvider.authorize();
            return true;
        }

        if (config.provider === "token") {
            const authorized = this.#tokenProvider.authorize(request.headers.authorization);

            if (!authorized) {
                response.writeHead(401, { "content-type": "application/json" });
                response.end(JSON.stringify({ error: "Unauthorized" }));
            }

            return authorized;
        }

        response.writeHead(501, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "Unsupported auth provider" }));
        return false;
    }
}
