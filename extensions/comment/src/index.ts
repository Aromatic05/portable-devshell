import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionCommentControlDecision } from "@portable-devshell/extension/comment";
import type { ToolCallReviewInvocation } from "@portable-devshell/extension/toolcall";
import {
    createError,
    errorCodes,
    type ContextMessageReadResult,
    type ContextMessageRecord,
    type ConversationEntry,
    type ConversationListInput,
    type InstanceEventType,
    type JsonValue,
    type PrefixRouteModuleDefinition,
    type ToolCallRecord,
} from "@portable-devshell/shared";

import {
    CommentService,
    createCommentRouteModule,
} from "./comment/CommentService.js";
import {
    ConversationService,
    createConversationRouteModule,
} from "./conversation/ConversationService.js";
import { createConversationPreferenceRouteModule } from "./conversation/preference/Route.js";
import { ConversationPreferenceStore } from "./conversation/preference/Store.js";
import { ConversationStore } from "./conversation/store/ConversationStore.js";
import { resolveToolCallFeedback } from "./hint/Feedback.js";

export interface CommentExtensionInstance {
    appendEvent(
        type: Extract<InstanceEventType, `context.message.${string}`>,
        data: JsonValue,
    ): Promise<void>;
    conversationDatabaseFile: string;
    key: object;
    legacyContextMessagesFile?: string;
    legacyReports?: () => Promise<ToolCallRecord[]>;
    name: string;
}

export interface CommentInstanceSource {
    list(): readonly CommentExtensionInstance[];
    onChange(listener: () => void): () => void;
}

export interface CommentPort {
    consumePending(
        instance: string,
        ctxId: string,
        callId: string,
    ): Promise<ContextMessageReadResult>;
    failPending(
        instance: string,
        ctxId: string,
        reason: string,
    ): Promise<ContextMessageRecord[]>;
    feedback(input: ToolCallReviewInvocation): readonly string[];
    pendingReplyCommentId(
        instance: string,
        ctxId: string,
    ): Promise<string | undefined>;
    reviewToolCall(
        instance: string,
        ctxId: string,
        toolName: string,
        requestId?: string,
    ): Promise<ExtensionCommentControlDecision>;
}

export interface ConversationPort {
    list(
        instance: string,
        input?: ConversationListInput,
    ): Promise<ConversationEntry[]>;
    recordReport(
        instance: string,
        input: {
            callId: string;
            createdAt?: string;
            ctxId: string;
            replyCommentId?: string;
            text: string;
        },
    ): Promise<void>;
}

export interface CommentRoutePort {
    control(): readonly PrefixRouteModuleDefinition[];
    instance(instance: string): readonly PrefixRouteModuleDefinition[];
}

interface CommentExtensionInstanceState {
    readonly comment: CommentService;
    readonly conversation: ConversationService;
    readonly key: object;
}

export class CommentExtension {
    readonly comment: CommentPort;
    readonly conversation: ConversationPort;
    readonly routes: CommentRoutePort;
    readonly #instances = new Map<string, CommentExtensionInstanceState>();
    readonly #source: CommentInstanceSource;
    readonly #unsubscribe: () => void;

    constructor(options: {
        instances: CommentInstanceSource;
        preferencesFile: string;
    }) {
        this.#source = options.instances;
        const preferences = new ConversationPreferenceStore(options.preferencesFile);
        const comment: CommentPort = {
            consumePending: async (instance, ctxId, callId) =>
                await this.#require(instance).comment.consumePending(ctxId, callId),
            failPending: async (instance, ctxId, reason) =>
                await this.#require(instance).comment.failPending(ctxId, reason),
            feedback: (input) => resolveToolCallFeedback(input),
            pendingReplyCommentId: async (instance, ctxId) =>
                await this.#require(instance).comment.pendingReplyCommentId(ctxId),
            reviewToolCall: async (
                instance,
                ctxId,
                toolName,
                requestId,
            ) =>
                await this.#require(instance).comment.reviewToolCall(
                    ctxId,
                    toolName,
                    requestId,
                ),
        };
        this.comment = Object.freeze(comment);
        const conversation: ConversationPort = {
            list: async (instance, input = {}) =>
                await this.#require(instance).conversation.list(input),
            recordReport: async (instance, input) =>
                await this.#require(instance).conversation.recordReport(input),
        };
        this.conversation = Object.freeze(conversation);
        const routes: CommentRoutePort = {
            control: () => [
                createConversationPreferenceRouteModule(preferences),
            ],
            instance: (instance) => {
                const state = this.#instances.get(instance);
                return state === undefined
                    ? []
                    : [
                          createCommentRouteModule(state.comment),
                          createConversationRouteModule(state.conversation),
                      ];
            },
        };
        this.routes = Object.freeze(routes);
        this.#sync();
        this.#unsubscribe = this.#source.onChange(() => this.#sync());
    }

    async retireInstance(instance: string, reason: string): Promise<void> {
        const state = this.#instances.get(instance);
        if (state === undefined) return;
        this.#instances.delete(instance);
        try {
            await state.comment.failAllPending(reason);
        } finally {
            state.conversation.close();
        }
    }

    close(): void {
        this.#unsubscribe();
        for (const state of this.#instances.values()) state.conversation.close();
        this.#instances.clear();
    }

    #sync(): void {
        const instances = this.#source.list();
        const names = new Set(instances.map((instance) => instance.name));
        for (const instance of instances) {
            const current = this.#instances.get(instance.name);
            if (current?.key === instance.key) continue;
            current?.conversation.close();
            const store = new ConversationStore({
                filePath: instance.conversationDatabaseFile,
                instanceName: instance.name,
                ...(instance.legacyContextMessagesFile === undefined
                    ? {}
                    : {
                          legacyContextMessagesFile:
                              instance.legacyContextMessagesFile,
                      }),
            });
            this.#instances.set(instance.name, {
                comment: new CommentService({
                    appendEvent: instance.appendEvent,
                    instanceName: instance.name,
                    store,
                }),
                conversation: new ConversationService({
                    legacyReports: instance.legacyReports,
                    store,
                }),
                key: instance.key,
            });
        }
        for (const name of [...this.#instances.keys()]) {
            if (names.has(name)) continue;
            void this.retireInstance(
                name,
                `Instance ${name} was removed before Comment delivery.`,
            ).catch(reportBackgroundError);
        }
    }

    #require(instance: string): CommentExtensionInstanceState {
        const state = this.#instances.get(instance);
        if (state !== undefined) return state;
        throw createError({
            code: errorCodes.instanceMissing,
            details: { instance },
            message: `Instance ${instance} was not found or is disabled.`,
            retryable: false,
        });
    }
}

export function commentExtensionDirectory(): string {
    return resolve(dirname(fileURLToPath(import.meta.url)), "builtin");
}

function reportBackgroundError(error: unknown): void {
    console.warn(error instanceof Error ? error : new Error(String(error)));
}
