const PASTE_BEGIN = "\u001B[200~";
const PASTE_END = "\u001B[201~";
const PASTE_MARKERS = [PASTE_BEGIN, PASTE_END] as const;
const MINIMUM_PARTIAL_LENGTH = 3;

export function stripBracketedPasteMarkers(value: string): {
    partial: string;
    text: string;
} {
    let text = value;
    for (const marker of PASTE_MARKERS) {
        text = text.split(marker).join("");
    }
    const length = trailingPartialMarkerLength(text);
    if (length === 0) {
        return { partial: "", text };
    }
    return {
        partial: text.slice(-length),
        text: text.slice(0, -length),
    };
}

function trailingPartialMarkerLength(value: string): number {
    for (
        let length = PASTE_BEGIN.length - 1;
        length >= MINIMUM_PARTIAL_LENGTH;
        length -= 1
    ) {
        if (value.length < length) {
            continue;
        }
        const suffix = value.slice(-length);
        if (!suffix.startsWith("\u001B")) {
            continue;
        }
        if (PASTE_MARKERS.some((marker) => marker.startsWith(suffix))) {
            return length;
        }
    }
    return 0;
}
