import type { TuiTerminalGraphicProtocol } from "./TuiTerminalModel.js";

export type TuiTerminalGraphicsMode = "auto" | "both" | "kitty" | "none" | "sixel";

export interface TuiTerminalGraphicsSupport {
    kitty: boolean;
    sixel: boolean;
}

export interface TuiTerminalGraphicPlacement {
    persistent: boolean;
    protocol: TuiTerminalGraphicProtocol;
    sequence: string;
    x: number;
    y: number;
}

export interface TuiTerminalGraphicRegion {
    height: number;
    width: number;
    x: number;
    y: number;
}

const ESCAPE = "\u001B";
const KITTY_DELETE_ALL = `${ESCAPE}_Ga=d,d=A;${ESCAPE}\\`;

export function detectTerminalGraphicsSupport(
    environment: NodeJS.ProcessEnv = process.env,
    mode: TuiTerminalGraphicsMode = readGraphicsMode(environment.DEVSHELL_TUI_GRAPHICS)
): TuiTerminalGraphicsSupport {
    if (mode !== "auto") {
        return {
            kitty: mode === "kitty" || mode === "both",
            sixel: mode === "sixel" || mode === "both"
        };
    }

    const program = `${environment.TERM_PROGRAM ?? ""} ${environment.LC_TERMINAL ?? ""}`.toLowerCase();
    const term = (environment.TERM ?? "").toLowerCase();
    const wezterm = program.includes("wezterm");
    return {
        kitty: environment.KITTY_WINDOW_ID !== undefined
            || wezterm
            || program.includes("ghostty")
            || term.includes("kitty"),
        sixel: wezterm
            || program.includes("mlterm")
            || term.includes("sixel")
    };
}

export function renderTerminalGraphicsFrame(options: {
    clear: boolean;
    graphics: readonly TuiTerminalGraphicPlacement[];
    region: TuiTerminalGraphicRegion;
    support: TuiTerminalGraphicsSupport;
}): string {
    const supported = options.graphics.filter((graphic) => options.support[graphic.protocol]);
    if (!options.clear && supported.length === 0) {
        return "";
    }

    let output = `${ESCAPE}7`;
    if (options.clear && options.support.kitty) {
        output += KITTY_DELETE_ALL;
    }
    for (const graphic of supported) {
        const x = options.region.x + clamp(graphic.x, 0, Math.max(0, options.region.width - 1));
        const y = options.region.y + clamp(graphic.y, 0, Math.max(0, options.region.height - 1));
        output += `${ESCAPE}[${y};${x}H${graphic.sequence}`;
    }
    output += `${ESCAPE}8`;
    return output;
}

export function terminalGraphicsClearSequence(support: TuiTerminalGraphicsSupport): string {
    return support.kitty ? `${ESCAPE}7${KITTY_DELETE_ALL}${ESCAPE}8` : "";
}

function readGraphicsMode(value: string | undefined): TuiTerminalGraphicsMode {
    switch (value?.trim().toLowerCase()) {
        case "both":
        case "kitty":
        case "none":
        case "sixel":
            return value.trim().toLowerCase() as TuiTerminalGraphicsMode;
        default:
            return "auto";
    }
}

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(Math.max(Math.floor(value), minimum), maximum);
}
