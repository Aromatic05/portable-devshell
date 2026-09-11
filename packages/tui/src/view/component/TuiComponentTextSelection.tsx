import { useSyncExternalStore } from "react";
import { Box, Text } from "ink";

import type { TuiTextSelectionRenderSource } from "../TuiTextSelectionModel.js";

export function TuiComponentTextSelection(props: {
    source: TuiTextSelectionRenderSource;
}) {
    const snapshot = useSyncExternalStore(
        (listener) => props.source.subscribe(listener),
        () => props.source.getSnapshot(),
        () => props.source.getSnapshot(),
    );
    return (
        <>
            {snapshot.spans.map((span, index) => (
                <Box
                    key={`${span.row}:${span.column}:${index}`}
                    marginLeft={span.column}
                    marginTop={span.row}
                    position="absolute"
                >
                    <Text inverse>{span.text}</Text>
                </Box>
            ))}
        </>
    );
}
