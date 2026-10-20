import { CommentService } from "../../src/comment/CommentService.ts";
import { MessageStore } from "../../src/message/store/MessageStore.ts";
import { databaseConnection } from "./Database.ts";

const [filePath, boundary] = process.argv.slice(2);
if (filePath === undefined || !["admission", "event-ack", "success"].includes(boundary!))
    throw new Error("Expected database path and admission|event-ack|success boundary");
const store = new MessageStore({ filePath, instanceName: "alpha", openDatabase: async () => {
    const database = await databaseConnection(filePath);
    return { ...database, async run(sql, values) {
        const changed = await database.run(sql, values);
        if (boundary === "event-ack" && sql.startsWith("UPDATE mailing_notifications SET queued_event_recorded"))
            process.exit(32);
        return changed;
    } };
} });
const service = new CommentService({ instanceName: "alpha", store, appendEvent: async () => {
    if (boundary === "admission") process.exit(31);
} });
const record = await service.queue({ ctxId: "owner", text: "New Mail\nFrom: sender\nSubject: Durable producer" },
    { instance: "alpha", workspace: "/workspace", ctxId: "owner", mailId: "sender#1", kind: "inbox:receiver" });
if (boundary !== "success") throw new Error("Producer crash boundary was not reached");
process.stdout.write(record.id);
await store.close();
