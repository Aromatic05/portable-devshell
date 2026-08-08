const CURSOR_POSITION_QUERY = "\u001B[6n";
const CURSOR_POSITION_RESPONSE = "\u001B[1;1R";

export interface CursorPositionResponder {
    consume(data: string): Promise<number>;
}

export function createCursorPositionResponder(
    sendResponse: (response: string) => Promise<void>,
): CursorPositionResponder {
    let pending = "";
    return {
        async consume(data: string): Promise<number> {
            pending += data;
            let responses = 0;
            while (true) {
                const queryIndex = pending.indexOf(CURSOR_POSITION_QUERY);
                if (queryIndex < 0) {
                    pending = pending.slice(-(CURSOR_POSITION_QUERY.length - 1));
                    return responses;
                }
                pending = pending.slice(queryIndex + CURSOR_POSITION_QUERY.length);
                await sendResponse(CURSOR_POSITION_RESPONSE);
                responses += 1;
            }
        },
    };
}
