import type { ExtensionContext } from "@portable-devshell/extension";
import { review } from "@portable-devshell/extension/toolcall";

import { createCommentReview } from "./Review.js";

export { createCommentReview } from "./Review.js";

export function activate(context: ExtensionContext): void {
    context.register(review, "comment", createCommentReview());
}
