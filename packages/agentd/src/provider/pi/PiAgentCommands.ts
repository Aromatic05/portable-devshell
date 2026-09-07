import type { PiSessionLike } from "./PiSdkLoader.js";

export type PiAgentMessageCommand = "followUp" | "prompt" | "steer";

export async function deliverPiAgentMessage(
    session: PiSessionLike,
    command: PiAgentMessageCommand,
    message: string
): Promise<void> {
    if (command === "followUp") {
        await session.followUp(message);
        return;
    }
    await acceptPiPrompt(session, message, session.isStreaming ? "steer" : undefined);
}

async function acceptPiPrompt(
    session: PiSessionLike,
    message: string,
    streamingBehavior?: "steer"
): Promise<void> {
    let accepted = false;
    let resolveAccepted = () => {};
    let rejectAccepted = (_error: unknown) => {};
    const acceptance = new Promise<void>((resolve, reject) => {
        resolveAccepted = resolve;
        rejectAccepted = reject;
    });
    const run = session.prompt(message, {
        ...(streamingBehavior === undefined ? {} : { streamingBehavior }),
        preflightResult(success) {
            if (!success) return;
            accepted = true;
            resolveAccepted();
        }
    });
    void run.catch((error: unknown) => {
        if (!accepted) rejectAccepted(error);
    });
    await acceptance;
}
