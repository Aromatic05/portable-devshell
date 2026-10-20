import { CommentService } from "../../src/comment/CommentService.ts";
import { MessageStore } from "../../src/message/store/MessageStore.ts";
import { databaseConnection } from "./Database.ts";

const [filePath, boundary] = process.argv.slice(2);
if (filePath === undefined || !["queued", "delivered"].includes(boundary!))
    throw new Error("Expected isolated SQLite path and queued|delivered crash boundary");
const store = new MessageStore({ filePath, instanceName: "crash-fixture",
    openDatabase: () => databaseConnection(filePath) });
const service = new CommentService({ instanceName: "crash-fixture", store,
    appendEvent: async (type) => {
        if (type === `context.message.${boundary}`) process.exit(boundary === "queued" ? 23 : 24);
    } });
await service.queue({ ctxId: "shared-context", text: "Original crash-boundary comment\nUnicode λ\n{plain prose" });
await service.consumePending("shared-context", "crashed-delivery");
throw new Error("Crash boundary was not reached");
