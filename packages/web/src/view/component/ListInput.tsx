import { useState } from "react";

/** Preserve separators while editing a comma-separated list. */
export function ListInput({ disabled, onChange, value }: {
    disabled?: boolean;
    onChange(value: string): void;
    value: string;
}) {
    const [text, setText] = useState<string>();
    return <input disabled={disabled} value={text ?? value}
        onChange={(event) => {
            setText(event.target.value);
            onChange(event.target.value);
        }}
        onBlur={() => setText(undefined)} />;
}
