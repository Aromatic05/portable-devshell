import {
    defineExtensionPoint,
    type ExtensionPointDeclaration
} from "../ExtensionApi.js";

export interface WebApplicationDeclaration extends ExtensionPointDeclaration {
    readonly id: string;
    readonly title: string;
}

export type WebApplicationSource =
    | {
          /** Relative directory below the Extension code directory. */
          readonly directory: string;
          readonly kind: "files";
      }
    | {
          readonly kind: "endpoint";
          resolve(): URL | Promise<URL | undefined> | undefined;
      };

export interface WebApplicationBinding {
    readonly source: WebApplicationSource;
}

export const applications = defineExtensionPoint<WebApplicationDeclaration, WebApplicationBinding>("web.applications");
