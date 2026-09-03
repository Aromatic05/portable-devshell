import type { PiSessionLike } from "./PiSdkLoader.js";

export type PiAgentMessageCommand = "followUp" | "prompt" | "steer";

export async function deliverPiAgentMessage(
    session: PiSessionLike,
    command: PiAgentMessageCommand,
    message: string
): Promise<void> {
    if (command === "followUp") {
        await session.prompt(message, { streamingBehavior: "followUp" });
        return;
    }
    await session.prompt(
        message,
        session.isStreaming ? { streamingBehavior: "steer" } : undefined
    );
}
