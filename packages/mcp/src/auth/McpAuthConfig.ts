export interface McpOAuth2Config {
    documentationUrl?: string;
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
          token: string;
      }
    | {
          enabled: true;
          oauth2: McpOAuth2Config;
          provider: "oauth2";
      };
