import {
    defineExtensionPoint,
    type ExtensionJsonValue,
    type ExtensionPointDeclaration
} from "./ExtensionApi.js";

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

export function parseWebApplicationDeclaration(value: ExtensionPointDeclaration): WebApplicationDeclaration {
    const record = value as ExtensionPointDeclaration & Record<string, ExtensionJsonValue | undefined>;
    const unknown = Object.keys(record).find((key) => key !== "id" && key !== "title");
    if (unknown !== undefined) throw new TypeError(`web.applications declaration has unknown field ${unknown}.`);
    if (typeof record.title !== "string" || record.title.length === 0 || record.title.trim() !== record.title) {
        throw new TypeError("web.applications declaration title must be a non-empty trimmed string.");
    }
    return Object.freeze({ id: value.id, title: record.title });
}
