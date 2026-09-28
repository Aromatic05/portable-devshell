import type { Component } from "@earendil-works/pi-tui";

import type { JsonValue } from "@portable-devshell/shared";

export interface PiThemeLike {
    bg(role: string, text: string): string;
    bold(text: string): string;
    fg(role: string, text: string): string;
    inverse(text: string): string;
}

export interface PiToolRenderContextLike {
    args: unknown;
    argsComplete: boolean;
    cwd: string;
    executionStarted: boolean;
    expanded: boolean;
    invalidate(): void;
    isError: boolean;
    isPartial: boolean;
    lastComponent?: Component;
    showImages: boolean;
    state: Record<string, unknown>;
    toolCallId: string;
}

export interface PiToolRenderResultOptionsLike {
    expanded: boolean;
    isPartial: boolean;
}

export interface PiToolRenderResultLike {
    content: Array<{ text?: string; type: string }>;
    details?: JsonValue;
}
