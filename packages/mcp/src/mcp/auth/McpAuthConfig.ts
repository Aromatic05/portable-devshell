export interface McpOAuth2Config {
    audience: string;
    documentationUrl?: string;
    issuer: string;
    jwksUri?: string;
    requiredScopes: string[];
    resourceName: string;
}

export type McpAuthConfig =
    | {
          enabled: false;
          provider: "none";
      }
    | {
          enabled: true;
          provider: "token";
      }
    | {
          enabled: true;
          oauth2: McpOAuth2Config;
          provider: "oauth2";
      };
