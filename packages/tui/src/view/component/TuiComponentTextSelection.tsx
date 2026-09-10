import { Box, Text } from "ink";

import type { TuiTextSelectionSnapshot } from "../TuiTextSelectionModel.js";

export function TuiComponentTextSelection(props: {
    snapshot: TuiTextSelectionSnapshot;
}) {
    return (
        <>
            {props.snapshot.spans.map((span, index) => (
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
