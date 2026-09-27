import {
    pages,
    type TuiPageBinding,
    type TuiPageDeclaration,
    type TuiPageRequest,
} from "@portable-devshell/extension/tui";
import type {
    JsonValue,
    PrefixRouteContext,
    PrefixRouteModuleDefinition,
    TuiPageDescriptor,
    TuiPageSnapshot,
} from "@portable-devshell/shared";

import { routeModule } from "../../../server/Route.js";
import type { ExtensionHost } from "../Host.js";

export interface TuiPagePort {
    invoke(
        pageId: string,
        request: TuiPageRequest,
        context: {
            localOwner: boolean;
            requestId: string;
            signal: AbortSignal;
        },
    ): Promise<TuiPageSnapshot>;
    list(): readonly TuiPageDescriptor[];
}

export class TuiExtensionPageService implements TuiPagePort {
    readonly #extensions: Pick<
        ExtensionHost,
        "acquireRegistration" | "listDeclarations"
    >;

    constructor(
        extensions: Pick<
            ExtensionHost,
            "acquireRegistration" | "listDeclarations"
        >,
    ) {
        this.#extensions = extensions;
    }

    list(): readonly TuiPageDescriptor[] {
        return this.#extensions
            .listDeclarations(pages.id)
            .map((registration) => {
                const declaration = registration.declaration as TuiPageDeclaration;
                return Object.freeze({
                    extensionId: registration.extensionId,
                    id: declaration.id,
                    title: declaration.title,
                });
            })
            .sort(
                (left, right) =>
                    left.title.localeCompare(right.title) ||
                    left.id.localeCompare(right.id),
            );
    }

    async invoke(
        pageId: string,
        request: TuiPageRequest,
        context: {
            localOwner: boolean;
            requestId: string;
            signal: AbortSignal;
        },
    ): Promise<TuiPageSnapshot> {
        const acquired = await this.#extensions.acquireRegistration(pages.id, pageId);
        const { lease, registration } = acquired;
        try {
            if (typeof registration.binding !== "function")
                throw new TypeError(`TUI page ${pageId} has an invalid binding.`);
            const snapshot = await (registration.binding as TuiPageBinding)(
                request,
                Object.freeze(context),
            );
            return validateSnapshot(snapshot, pageId);
        } finally {
            lease.release();
        }
    }
}

export function createTuiPageRouteModule(
    port: TuiPagePort,
): PrefixRouteModuleDefinition {
    return routeModule("tui", {
        page: async (request, context) => {
            requireTui(context);
            const input = readPageRequest(request.payload);
            return (await port.invoke(input.pageId, input.request, {
                localOwner: context.subject?.kind === "local-owner",
                requestId: context.requestId,
                signal: context.signal,
            })) as unknown as JsonValue;
        },
        pages: (_request, context) => {
            requireTui(context);
            return [...port.list()] as unknown as JsonValue;
        },
    });
}

function readPageRequest(payload: JsonValue | undefined): {
    pageId: string;
    request: TuiPageRequest;
} {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload))
        throw new TypeError("tui.page requires an object payload.");
    const pageId = readText(payload.pageId, "pageId");
    if (payload.kind === "read") return { pageId, request: { kind: "read" } };
    if (payload.kind === "action") {
        return {
            pageId,
            request: {
                actionId: readText(payload.actionId, "actionId"),
                ...(payload.itemId === undefined
                    ? {}
                    : { itemId: readText(payload.itemId, "itemId") }),
                kind: "action",
            },
        };
    }
    throw new TypeError("tui.page kind must be read or action.");
}

function requireTui(context: PrefixRouteContext): void {
    if (context.peer !== "tui")
        throw new TypeError("TUI page access is available only to TUI clients.");
}

function readText(value: JsonValue | undefined, label: string): string {
    if (typeof value === "string" && value.length > 0) return value;
    throw new TypeError(`${label} must be a non-empty string.`);
}

function validateSnapshot(value: TuiPageSnapshot, pageId: string): TuiPageSnapshot {
    if (!isRecord(value) || !Array.isArray(value.items))
        throw new TypeError(`TUI page ${pageId} returned an invalid snapshot.`);
    const itemIds = new Set<string>();
    for (const item of value.items) {
        if (!isRecord(item) || !Array.isArray(item.summary)) {
            throw new TypeError(`TUI page ${pageId} returned an invalid item.`);
        }
        const itemId = readSnapshotText(item.id, pageId, "item id");
        assertUnique(itemIds, itemId, pageId, "item id");
        readSnapshotText(item.title, pageId, "item title");
        for (const line of item.summary) validateLine(line, pageId);
        if (item.detail !== undefined) {
            if (!Array.isArray(item.detail)) invalid(pageId, "item detail");
            for (const line of item.detail) validateLine(line, pageId);
        }
        if (
            item.status !== undefined &&
            ![
                "normal",
                "ready",
                "running",
                "warning",
                "failed",
                "disabled",
                "pending",
            ].includes(String(item.status))
        )
            invalid(pageId, "item status");
        if (item.actions !== undefined) {
            if (!Array.isArray(item.actions)) invalid(pageId, "item actions");
            const actionIds = new Set<string>();
            for (const action of item.actions) {
                if (!isRecord(action)) invalid(pageId, "item action");
                const actionId = readSnapshotText(action.id, pageId, "action id");
                assertUnique(actionIds, actionId, pageId, "action id");
                readSnapshotText(action.label, pageId, "action label");
                if (
                    action.tone !== undefined &&
                    action.tone !== "normal" &&
                    action.tone !== "danger"
                )
                    invalid(pageId, "action tone");
            }
        }
    }
    return structuredClone(value);
}

function validateLine(value: unknown, pageId: string): void {
    if (!isRecord(value)) invalid(pageId, "line");
    readSnapshotText(value.text, pageId, "line text");
    if (
        value.tone !== undefined &&
        ![
            "normal",
            "muted",
            "accent",
            "success",
            "warning",
            "danger",
        ].includes(String(value.tone))
    )
        invalid(pageId, "line tone");
}

function readSnapshotText(value: unknown, pageId: string, label: string): string {
    if (
        typeof value === "string" &&
        value.length > 0 &&
        value.trim() === value
    )
        return value;
    return invalid(pageId, label);
}

function assertUnique(
    values: Set<string>,
    value: string,
    pageId: string,
    label: string,
): void {
    if (values.has(value)) invalid(pageId, `duplicate ${label}`);
    values.add(value);
}

function invalid(pageId: string, label: string): never {
    throw new TypeError(`TUI page ${pageId} returned invalid ${label}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
