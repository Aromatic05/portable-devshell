import type { ArtifactViewImageResult } from "@portable-devshell/shared";

import {
    detectTerminalGraphicsSupport,
    type TuiTerminalGraphicRegion,
    type TuiTerminalGraphicsMode
} from "./TuiTerminalGraphicsRenderer.js";

export interface TuiTerminalImageSupport {
    iterm2: boolean;
    kitty: boolean;
}

export interface TuiTerminalImageFrame {
    protocol: "iterm2" | "kitty" | "none";
    reason?: string;
    sequence: string;
}

const ESCAPE = "\u001B";
const STRING_TERMINATOR = `${ESCAPE}\\`;
const KITTY_DELETE_ALL = `${ESCAPE}_Ga=d,d=A;${STRING_TERMINATOR}`;
const KITTY_CHUNK_LENGTH = 4096;

export function detectTerminalImageSupport(
    environment: NodeJS.ProcessEnv = process.env,
    mode?: TuiTerminalGraphicsMode
): TuiTerminalImageSupport {
    const graphics = detectTerminalGraphicsSupport(environment, mode);
    const program = `${environment.TERM_PROGRAM ?? ""} ${environment.LC_TERMINAL ?? ""}`.toLowerCase();
    const disabled = mode === "none" || environment.DEVSHELL_TUI_GRAPHICS?.trim().toLowerCase() === "none";
    return {
        iterm2: !disabled && (program.includes("iterm") || program.includes("wezterm")),
        kitty: graphics.kitty
    };
}

export function renderTerminalImageFrame(options: {
    image: ArtifactViewImageResult;
    region: TuiTerminalGraphicRegion;
    support: TuiTerminalImageSupport;
}): TuiTerminalImageFrame {
    if (options.image.mediaType === "image/png" && options.support.kitty) {
        return {
            protocol: "kitty",
            sequence: renderKittyPng(options.image, options.region)
        };
    }
    if (options.support.iterm2) {
        return {
            protocol: "iterm2",
            sequence: renderIterm2Image(options.image, options.region)
        };
    }
    return {
        protocol: "none",
        reason: options.image.mediaType === "image/png"
            ? "Host terminal does not advertise Kitty or iTerm2 image support."
            : `${options.image.mediaType} preview requires an iTerm2-compatible host terminal.`,
        sequence: ""
    };
}

export function terminalImageClearSequence(support: TuiTerminalImageSupport): string {
    return support.kitty ? `${ESCAPE}7${KITTY_DELETE_ALL}${ESCAPE}8` : "";
}

function renderKittyPng(image: ArtifactViewImageResult, region: TuiTerminalGraphicRegion): string {
    const chunks = chunk(image.content, KITTY_CHUNK_LENGTH);
    let output = `${ESCAPE}7${KITTY_DELETE_ALL}${ESCAPE}[${region.y};${region.x}H`;
    for (let index = 0; index < chunks.length; index += 1) {
        const first = index === 0;
        const more = index < chunks.length - 1;
        const control = first
            ? `a=T,f=100,q=2,C=1,c=${region.width},r=${region.height},m=${more ? 1 : 0}`
            : `m=${more ? 1 : 0}`;
        output += `${ESCAPE}_G${control};${chunks[index]}${STRING_TERMINATOR}`;
    }
    return `${output}${ESCAPE}8`;
}

function renderIterm2Image(image: ArtifactViewImageResult, region: TuiTerminalGraphicRegion): string {
    const name = Buffer.from(image.name, "utf8").toString("base64");
    return `${ESCAPE}7${ESCAPE}[${region.y};${region.x}H${ESCAPE}]1337;File=name=${name};inline=1;width=${region.width};height=${region.height};preserveAspectRatio=1;doNotMoveCursor=1:${image.content}\u0007${ESCAPE}8`;
}

function chunk(value: string, size: number): string[] {
    if (value.length === 0) {
        return [""];
    }
    const output: string[] = [];
    for (let offset = 0; offset < value.length; offset += size) {
        output.push(value.slice(offset, offset + size));
    }
    return output;
}
