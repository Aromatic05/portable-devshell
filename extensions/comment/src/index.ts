import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export { CommentService, type CommentServiceOptions } from "./comment/CommentService.js";
export { CommentState, type CommentDocument } from "./comment/CommentState.js";
export { composeComments, mergeComments, type CommentAdvice } from "./comment/Merge.js";
export { ConversationService } from "./conversation/ConversationService.js";
export {
    ConversationStore,
    type ConversationStoreStats,
} from "./conversation/store/ConversationStore.js";
export {
    CONVERSATION_DATABASE_SCHEMA_VERSION,
    defaultConversationStorageLimits,
} from "./conversation/store/Schema.js";
export type { ConversationControlState } from "./conversation/ConversationControl.js";
export {
    diagnosticHint,
    errorHint,
    formatHint,
    type ToolDiagnosticHint,
} from "./hint/Hint.js";
export { resolveErrorHints, resolveResultHints } from "./hint/Resolver.js";

export function commentExtensionDirectory(): string {
    return resolve(dirname(fileURLToPath(import.meta.url)), "builtin");
}
