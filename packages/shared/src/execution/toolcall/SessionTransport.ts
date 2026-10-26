import type { Endpoint } from "../../transport/endpoint/Endpoint.js";
import { createPortClient } from "../../transport/endpoint/PortClient.js";
import { asInstanceName } from "../../types/Instance.js";
import type { JsonValue } from "../../types/Json.js";
import type { ToolCallContext } from "./Type.js";
import type { InstanceWorkerInfo } from "../process/Model.js";
import { createRemoteError, type RemoteErrorBody } from "../../transport/Error.js";

export interface ToolSessionBinding {
    generation: string;
    sessionId: string;
    token: string;
}

export interface ToolSessionOpenInput {
    generation: string;
    sessionId: string;
    context: ToolCallContext & { extensionId: string; workspace: string; source: "extension" };
    recording: "host" | "caller";
}

export interface OwnedToolSession {
    binding: ToolSessionBinding;
    environment: { homeDirectory: string; platform: InstanceWorkerInfo["platform"] };
    tools: { name: string; description: string; inputSchema: JsonValue }[];
    workspace: string;
}

/** A retained stream addresses its original owner even after host removal/replacement. */
export async function openToolSessionTransport(
    endpoint: Endpoint,
    instance: string,
    input: ToolSessionOpenInput,
): Promise<OwnedToolSession & { activate(): Promise<void>; close(): Promise<void> }> {
    const stream = await createPortClient(endpoint, asInstanceName(instance), "tool")
        .open("ownedSession", input);
    const first = await stream.readMessage();
    if (first.type !== "data") throw new Error("Worker session closed before opening.");
    const opened = first.message as unknown as OwnedToolSession;
    let released = false;
    stream.onClose(() => { released = true; });
    let tail = Promise.resolve();
    const request = (name: "activate" | "close") => {
        const result = tail.then(async () => {
            try {
                await stream.send({ name, binding: opened.binding } as unknown as JsonValue);
            } catch (error) {
                // Only an observed owner acknowledgement proves cleanup succeeded.
                if (released && name === "close") return;
                throw error;
            }
            const reply = await stream.readMessage();
            if (reply.type === "close" && name === "close") return;
            if (reply.type !== "data") throw new Error("Worker session is closed.");
            const result = reply.message as unknown as { error?: RemoteErrorBody };
            if (result.error !== undefined) throw createRemoteError(result.error);
        });
        tail = result.catch(() => undefined);
        return result;
    };
    return { ...opened, activate: () => request("activate"), close: () => request("close") };
}
