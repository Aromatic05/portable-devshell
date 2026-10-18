import stringWidth from "string-width";

/** Shared terminal-width layout for View and keyboard-driven scrolling. */
export function wrapTerminalText(text: string, width: number): string[] {
    const safeWidth = Math.max(1, width);
    const output: string[] = [];

    for (const sourceLine of text.split(/\r?\n/u)) {
        if (sourceLine.length === 0) {
            output.push("");
            continue;
        }

        let current = "";
        for (const token of sourceLine.match(/\s+|\S+/gu) ?? []) {
            if (stringWidth(current + token) <= safeWidth) {
                current += token;
                continue;
            }

            if (current.length > 0) {
                output.push(current.trimEnd());
                current = token.trimStart();
            } else {
                current = token;
            }

            while (stringWidth(current) > safeWidth) {
                const chunk = takeTerminalWidth(current, safeWidth);
                output.push(chunk);
                current = current.slice(chunk.length);
            }
        }

        output.push(current.trimEnd());
    }

    return output;
}

export function takeTerminalWidth(text: string, width: number): string {
    let output = "";
    for (const segment of new Intl.Segmenter(undefined, {
        granularity: "grapheme",
    }).segment(text)) {
        if (stringWidth(output + segment.segment) > width) {
            break;
        }
        output += segment.segment;
    }
    return output.length === 0 ? text.slice(0, 1) : output;
}

export function tuiTextDetailImageRows(viewportRows: number): number {
    const available = Math.max(2, Math.floor(viewportRows) - 4);
    return Math.max(2, Math.min(16, Math.floor(available * 0.6)));
}

export function tuiTextDetailBodyRows(
    viewportRows: number,
    hasImage: boolean,
): number {
    return Math.max(
        1,
        Math.floor(viewportRows) -
            2 -
            (hasImage ? tuiTextDetailImageRows(viewportRows) + 1 : 0),
    );
}
