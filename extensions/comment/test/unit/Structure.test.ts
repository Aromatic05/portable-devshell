import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import { commentExtensionDirectory } from "../../src/index.ts";

async function entries(path: URL | string): Promise<string[]> {
    return (await readdir(path)).sort();
}

test("Comment source tree follows domain entities and the builtin source is self-contained", async () => {
    const src = new URL("../../src/", import.meta.url);
    assert.deepEqual(await entries(src), [
        "builtin",
        "comment",
        "conversation",
        "hint",
        "index.ts",
    ]);
    assert.deepEqual(await entries(new URL("../../src/builtin/", import.meta.url)), [
        "CommentReview.ts",
        "devshell-extension.json",
        "index.ts",
    ]);
    assert.deepEqual(await entries(new URL("../../src/comment/", import.meta.url)), [
        "CommentService.ts",
        "CommentState.ts",
        "Merge.ts",
    ]);
    assert.deepEqual(await entries(new URL("../../src/conversation/", import.meta.url)), [
        "ConversationControl.ts",
        "ConversationService.ts",
        "migration",
        "store",
    ]);
    assert.deepEqual(await entries(new URL("../../src/conversation/migration/", import.meta.url)), [
        "Comment.ts",
        "Control.ts",
        "Report.ts",
    ]);
    assert.deepEqual(await entries(new URL("../../src/conversation/store/", import.meta.url)), [
        "ConversationStore.ts",
        "Query.ts",
        "Schema.ts",
    ]);
    assert.deepEqual(await entries(new URL("../../src/hint/", import.meta.url)), [
        "Hint.ts",
        "Resolver.ts",
        "tool",
    ]);
    assert.deepEqual(await entries(new URL("../../src/hint/tool/", import.meta.url)), [
        "Error.ts",
        "Value.ts",
        "control",
        "worker",
    ]);
    assert.deepEqual(await entries(new URL("../../src/hint/tool/control/", import.meta.url)), [
        "Artifact.ts",
        "Instance.ts",
        "Todo.ts",
    ]);
    assert.deepEqual(await entries(new URL("../../src/hint/tool/worker/", import.meta.url)), [
        "Bash.ts",
        "File.ts",
        "Tmux.ts",
    ]);

    assert.equal(
        commentExtensionDirectory(),
        new URL("../../src/builtin/", import.meta.url).pathname.replace(/\/$/u, ""),
    );
    const review = await readFile(
        new URL("../../src/builtin/CommentReview.ts", import.meta.url),
        "utf8",
    );
    assert.equal(review.includes("@portable-devshell/shared"), false);
});
