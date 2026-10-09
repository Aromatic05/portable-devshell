export interface McpOAuth2Config {
    documentationUrl?: string;
    requiredScopes: string[];
    resourceName: string;
}

export type McpOAuthApprovalConfig =
    | { mode: "tui" }
    | { mode: "token"; token?: string };

export type McpAuthConfig =
    | {
          enabled: false;
          provider: "none";
      }
    | {
          enabled: true;
          provider: "token";
          token: string;
      }
    | {
          enabled: true;
          oauth2: McpOAuth2Config;
          provider: "oauth2";
      };

export class McpAuthPublicBaseUrlValidator {
    isLocalhost(publicBaseUrl: string | undefined): boolean {
        if (publicBaseUrl === undefined) {
            return true;
        }

        const url = new URL(publicBaseUrl);
        return url.hostname === "localhost" || url.hostname === "127.0.0.1";
    }
}
