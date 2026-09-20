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
    enabled: boolean;
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
    pendingPushMessage(
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
    enabled: boolean;
    readonly key: object;
    retirement?: Promise<void>;
}

export class CommentExtension {
    readonly comment: CommentPort;
    readonly conversation: ConversationPort;
    readonly routes: CommentRoutePort;
    readonly #instances = new Map<string, CommentExtensionInstanceState>();
    readonly #retirements = new Set<Promise<void>>();
    readonly #source: CommentInstanceSource;
    readonly #unsubscribe: () => void;

    constructor(options: {
        instances: CommentInstanceSource;
        preferencesFile: string;
    }) {
        this.#source = options.instances;
        const preferences = new ConversationPreferenceStore(
            options.preferencesFile,
        );
        const comment: CommentPort = {
            consumePending: async (instance, ctxId, callId) =>
                await this.#require(instance).comment.consumePending(
                    ctxId,
                    callId,
                ),
            failPending: async (instance, ctxId, reason) =>
                await this.#require(instance).comment.failPending(
                    ctxId,
                    reason,
                ),
            feedback: (input) => resolveToolCallFeedback(input),
            pendingReplyCommentId: async (instance, ctxId) =>
                await this.#require(instance).comment.pendingReplyCommentId(
                    ctxId,
                ),
            pendingPushMessage: async (instance, ctxId) =>
                await this.#require(instance).comment.pendingPushMessage(ctxId),
            reviewToolCall: async (instance, ctxId, toolName, requestId) =>
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
                return state === undefined || !state.enabled
                    ? []
                    : [
                          createCommentRouteModule({
                              list: async (input) =>
                                  await this.#require(instance).comment.list(
                                      input,
                                  ),
                              queue: async (input) =>
                                  await this.#require(instance).comment.queue(
                                      input,
                                  ),
                          }),
                          createConversationRouteModule({
                              list: async (input) =>
                                  await this.#require(
                                      instance,
                                  ).conversation.list(input),
                          }),
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
        state.enabled = false;
        if (this.#instances.get(instance) === state)
            this.#instances.delete(instance);
        await this.#retireState(state, reason);
    }

    async close(): Promise<void> {
        this.#unsubscribe();
        const states = [...this.#instances.values()];
        for (const state of states) state.enabled = false;
        this.#instances.clear();
        for (const state of states) this.#retireState(state);
        const settled = await Promise.allSettled([...this.#retirements]);
        const failures = settled
            .filter(
                (result): result is PromiseRejectedResult =>
                    result.status === "rejected",
            )
            .map((result) => result.reason);
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1)
            throw new AggregateError(
                failures,
                "Comment shutdown was incomplete.",
            );
    }

    #sync(): void {
        const instances = this.#source.list();
        const names = new Set(instances.map((instance) => instance.name));
        for (const instance of instances) {
            const current = this.#instances.get(instance.name);
            if (current?.key === instance.key) {
                current.enabled = instance.enabled;
                continue;
            }
            if (!instance.enabled) {
                if (current !== undefined) current.enabled = false;
                continue;
            }
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
            const next: CommentExtensionInstanceState = {
                comment: new CommentService({
                    appendEvent: instance.appendEvent,
                    instanceName: instance.name,
                    store,
                }),
                conversation: new ConversationService({
                    instanceName: instance.name,
                    legacyReports: instance.legacyReports,
                    store,
                }),
                enabled: true,
                key: instance.key,
            };
            this.#instances.set(instance.name, next);
            if (current !== undefined) {
                current.enabled = false;
                void this.#retireState(current).catch(reportBackgroundError);
            }
        }
        for (const name of [...this.#instances.keys()]) {
            if (names.has(name)) continue;
            const state = this.#instances.get(name);
            if (state !== undefined) state.enabled = false;
            void this.retireInstance(
                name,
                `Instance ${name} was removed before Comment delivery.`,
            ).catch(reportBackgroundError);
        }
    }

    #require(instance: string): CommentExtensionInstanceState {
        const state = this.#instances.get(instance);
        if (state !== undefined && state.enabled) return state;
        throw createError({
            code: errorCodes.instanceMissing,
            details: { instance },
            message: `Instance ${instance} was not found or is disabled.`,
            retryable: false,
        });
    }

    #retireState(
        state: CommentExtensionInstanceState,
        reason?: string,
    ): Promise<void> {
        if (state.retirement !== undefined) return state.retirement;
        state.enabled = false;
        const comment = state.comment.retire(reason);
        const conversation = state.conversation.retire();
        const retirement = (async () => {
            const settled = await Promise.allSettled([comment, conversation]);
            const failures = settled
                .filter(
                    (result): result is PromiseRejectedResult =>
                        result.status === "rejected",
                )
                .map((result) => result.reason);
            try {
                state.conversation.close();
            } catch (error) {
                failures.push(error);
            }
            if (failures.length === 1) throw failures[0];
            if (failures.length > 1)
                throw new AggregateError(
                    failures,
                    "Comment instance retirement was incomplete.",
                );
        })();
        state.retirement = retirement;
        this.#retirements.add(retirement);
        void retirement.then(
            () => this.#retirements.delete(retirement),
            () => this.#retirements.delete(retirement),
        );
        return retirement;
    }
}

export function commentExtensionDirectory(): string {
    return resolve(dirname(fileURLToPath(import.meta.url)), "builtin");
}

function reportBackgroundError(error: unknown): void {
    console.warn(error instanceof Error ? error : new Error(String(error)));
}
