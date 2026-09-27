import {
    defineExtensionPoint,
    type ExtensionPointDeclaration,
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

export interface WebPageDeclaration extends ExtensionPointDeclaration {
    readonly id: string;
    readonly title: string;
}

export type WebPageTone = "normal" | "success" | "warning" | "danger";

export interface WebPageCell {
    readonly href?: string;
    readonly text: string;
    readonly tone?: WebPageTone;
}

export interface WebPageColumn {
    readonly id: string;
    readonly label: string;
}

export interface WebPageAction {
    readonly id: string;
    readonly label: string;
    readonly tone?: "normal" | "danger";
}

export interface WebPageRow {
    readonly actions?: readonly WebPageAction[];
    readonly cells: Readonly<Record<string, WebPageCell>>;
    readonly id: string;
}

export interface WebPageTable {
    readonly columns: readonly WebPageColumn[];
    readonly id: string;
    readonly rows: readonly WebPageRow[];
    readonly title?: string;
}

export interface WebPageSnapshot {
    readonly tables: readonly WebPageTable[];
}

export type WebPageRequest =
    | { readonly kind: "read" }
    | {
          readonly actionId: string;
          readonly kind: "action";
          readonly rowId?: string;
      };

export interface WebPageInvocationContext {
    readonly requestId: string;
    readonly signal: AbortSignal;
}

export type WebPageBinding = (
    request: WebPageRequest,
    context: WebPageInvocationContext,
) => Promise<WebPageSnapshot> | WebPageSnapshot;

export const applications = defineExtensionPoint<
    WebApplicationDeclaration,
    WebApplicationBinding
>("web.applications");

/** Browser content mounted inside the portable-devshell Web shell. */
export const pages = defineExtensionPoint<WebPageDeclaration, WebPageBinding>(
    "web.pages",
);
