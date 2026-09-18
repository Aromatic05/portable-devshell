import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import type { JsonValue, PrefixRouteContext } from "@portable-devshell/shared";

import {
    CommentExtension,
    type CommentExtensionInstance,
    type CommentInstanceSource,
} from "../../src/index.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

const routeContext = {
    connectionId: "conn-comment",
    peer: "cli",
    requestId: "request-comment",
} as PrefixRouteContext;


class TestCommentInstances implements CommentInstanceSource {
    readonly #listeners = new Set<() => void>();
    #instances: readonly CommentExtensionInstance[];

    constructor(instances: readonly CommentExtensionInstance[]) {
        this.#instances = instances;
    }

    list(): readonly CommentExtensionInstance[] {
        return this.#instances;
    }

    onChange(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    replace(instances: readonly CommentExtensionInstance[]): void {
        this.#instances = instances;
        for (const listener of this.#listeners) listener();
    }
}

test("CommentExtension owns instance state, routes, preferences, and replacement persistence", async () => {
    const root = await createTestTempDirectory("comment-extension-owner");
    const preferencesFile = join(root, "conversation-preferences.json");
    const conversationDatabaseFile = join(root, "conversation.sqlite3");
    const legacyContextMessagesFile = join(root, "context-messages.json");
    const events: Array<{ data: JsonValue; type: string }> = [];
    const firstKey = {};
    const instances = new TestCommentInstances([
        {
            appendEvent: async (type, data) => {
                events.push({ data, type });
            },
            conversationDatabaseFile,
            key: firstKey,
            legacyContextMessagesFile,
            legacyReports: async () => [],
            name: "alpha",
        },
    ]);
    const extension = new CommentExtension({ instances, preferencesFile });

    assert.deepEqual(
        extension.routes.instance("alpha").map((route) => route.name),
        ["contextMessage", "conversation"],
    );
    assert.deepEqual(
        extension.routes.control().map((route) => route.name),
        ["conversation"],
    );

    const contextMessage = extension
        .routes.instance("alpha")
        .find((route) => route.name === "contextMessage");
    const queue = contextMessage?.operations.find(
        (operation) => operation.name === "queue",
    );
    if (queue === undefined) throw new Error("contextMessage.queue is missing");
    await queue.handle(
        {
            id: "queue-1",
            name: "queue",
            payload: { ctxId: "ctx-alpha", text: "Persist this Comment" },
        },
        routeContext,
    );

    instances.replace([
        {
            appendEvent: async (type, data) => {
                events.push({ data, type });
            },
            conversationDatabaseFile,
            key: {},
            legacyContextMessagesFile,
            legacyReports: async () => [],
            name: "alpha",
        },
    ]);

    const conversation = extension
        .routes.instance("alpha")
        .find((route) => route.name === "conversation");
    const list = conversation?.operations.find(
        (operation) => operation.name === "list",
    );
    if (list === undefined) throw new Error("conversation.list is missing");
    const history = (await list.handle(
        { id: "list-1", name: "list", payload: { ctxId: "ctx-alpha" } },
        routeContext,
    )) as Array<{ kind: string; text: string }>;
    assert.deepEqual(
        history.map(({ kind, text }) => ({ kind, text })),
        [{ kind: "comment", text: "Persist this Comment" }],
    );

    const preferenceRoute = extension.routes.control()[0]!;
    const updatePreferences = preferenceRoute.operations.find(
        (operation) => operation.name === "updatePreferences",
    );
    const preferences = preferenceRoute.operations.find(
        (operation) => operation.name === "preferences",
    );
    if (updatePreferences === undefined || preferences === undefined)
        throw new Error("Conversation preference routes are missing");
    await updatePreferences.handle(
        {
            id: "preferences-update",
            name: "updatePreferences",
            payload: { titles: { "alpha\\u0000ctx-alpha": "Alpha" } },
        },
        routeContext,
    );
    assert.equal(
        ((await preferences.handle(
            { id: "preferences", name: "preferences" },
            routeContext,
        )) as { titles: Record<string, string> }).titles["alpha\\u0000ctx-alpha"],
        "Alpha",
    );

    instances.replace([]);
    assert.deepEqual(extension.routes.instance("alpha"), []);
    extension.close();
    assert.equal(events.some((event) => event.type === "context.message.queued"), true);
});
