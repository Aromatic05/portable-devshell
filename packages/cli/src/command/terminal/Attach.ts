import { StringDecoder } from "node:string_decoder";
import {
    STREAM_GAP_CODE,
    type TerminalAttachment,
    type TerminalSessionDescriptor,
    type TerminalTransport,
} from "@portable-devshell/shared";

const CTRL_RBRACKET = 0x1d;
const CHORD_TIMEOUT_MS = 800;
const MAX_GAP_RECONNECTS = 5;
const GAP_WINDOW_MS = 2_000;
const FULL_TERMINAL_RESET =
    "\u001B]0;\u0007\u001B[0m\u001B[?25h\u001B[?1l\u001B[?1000l\u001B[?1002l\u001B[?1003l\u001B[?1006l\u001B[?2004l\u001B[?1049l";

export interface AttachControlTerminalOptions {
    initialTakeover: boolean;
    session: TerminalSessionDescriptor;
    stderr: { write(chunk: string): void };
    stdin: NodeJS.ReadableStream;
    stdout: { write(chunk: string): void };
    transport: TerminalTransport;
}

export async function attachControlTerminal(
    options: AttachControlTerminalOptions,
): Promise<void> {
    const stdinTty = options.stdin as NodeJS.ReadStream;
    const stdoutTty = options.stdout as NodeJS.WriteStream;
    let session = { ...options.session };
    let controlling = options.initialTakeover;
    let clientSeq = 0;
    let detaching = false;
    let stream: TerminalAttachment | undefined;
    let latestSeq = 0;
    let chordPending = false;
    let chordTimer: ReturnType<typeof setTimeout> | undefined;
    let operationTail = Promise.resolve();
    const inputDecoder = new StringDecoder("utf8");
    const pendingControls = new Map<
        number,
        { reject(error: Error): void; resolve(humanControl: boolean): void }
    >();

    const writeTitle = (note?: string) => {
        const mode = controlling ? "[CONTROL]" : "[OBSERVE]";
        const label =
            session.name !== undefined && session.name.length > 0
                ? session.name
                : session.terminalId.slice(0, 16);
        const hint =
            note ??
            (controlling
                ? "Ctrl+] d detach | Ctrl+] t observe"
                : "read-only | Ctrl+] t takeover | Ctrl+] d detach");
        options.stdout.write(
            `\u001B]0;devshell ${mode} ${label} (${session.cols}x${session.rows}) — ${hint}\u0007`,
        );
    };

    const enqueue = (operation: () => Promise<void>) => {
        operationTail = operationTail.then(operation).catch((error: unknown) => {
            if (detaching) return;
            const message =
                error instanceof Error ? error.message : String(error);
            options.stderr.write(`\r\n[terminal] ${message}\r\n`);
        });
    };

    const sendCurrentSize = () => {
        if (!controlling || detaching) return;
        const cols = stdoutTty.columns ?? session.cols;
        const rows = stdoutTty.rows ?? session.rows;
        if (cols < 2 || rows < 1) return;
        enqueue(async () => {
            if (!controlling || detaching || stream === undefined) return;
            const seq = ++clientSeq;
            await stream.sendResize(cols, rows, {
                clientSeq: seq,
                generation: session.generation,
                terminalId: session.terminalId,
                version: session.version,
            });
        });
    };

    const detach = () => {
        if (detaching) return;
        detaching = true;
        clearTimeout(chordTimer);
        chordTimer = undefined;
        stream?.close();
    };

    const toggleControl = () => {
        enqueue(async () => {
            if (detaching || stream === undefined) return;
            if (stream.sendControl === undefined) {
                options.stdout.write("\x07");
                return;
            }
            const nextTakeover = !controlling;
            const seq = ++clientSeq;
            const confirmed = new Promise<boolean>((resolve, reject) => {
                pendingControls.set(seq, { reject, resolve });
            });
            try {
                await stream.sendControl(nextTakeover, {
                    clientSeq: seq,
                    generation: session.generation,
                    terminalId: session.terminalId,
                    version: session.version,
                });
                controlling = await confirmed;
                writeTitle();
                if (controlling) sendCurrentSize();
            } catch (error) {
                pendingControls.delete(seq);
                options.stdout.write("\x07");
                const message =
                    error instanceof Error ? error.message : String(error);
                writeTitle(message);
            }
        });
    };

    const forwardInput = (bytes: Buffer) => {
        if (bytes.length === 0) return;
        if (!controlling) {
            options.stdout.write("\x07");
            return;
        }
        const text = inputDecoder.write(bytes);
        if (text.length === 0) return;
        enqueue(async () => {
            if (!controlling || detaching || stream === undefined) return;
            const seq = ++clientSeq;
            await stream.sendInput(text, {
                clientSeq: seq,
                generation: session.generation,
                terminalId: session.terminalId,
                version: session.version,
            });
        });
    };

    const onStdinData = (chunk: Buffer | string) => {
        if (detaching) return;
        const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
        const pendingOut: number[] = [];
        const flushOut = () => {
            if (pendingOut.length === 0) return;
            forwardInput(Buffer.from(pendingOut));
            pendingOut.length = 0;
        };

        for (const byte of buf) {
            if (chordPending) {
                chordPending = false;
                clearTimeout(chordTimer);
                chordTimer = undefined;
                if (byte === 0x64 || byte === 0x44 || byte === CTRL_RBRACKET) {
                    // d / D / Ctrl+] -> detach
                    flushOut();
                    detach();
                    return;
                }
                if (byte === 0x74 || byte === 0x54) {
                    // t / T -> toggle observe/control
                    flushOut();
                    toggleControl();
                    continue;
                }
                if (byte === 0x5d) {
                    // ] -> send literal Ctrl+]
                    if (controlling) pendingOut.push(CTRL_RBRACKET);
                    writeTitle();
                    continue;
                }
                // Any other key after Ctrl+] stays attached and shows hint.
                writeTitle("Ctrl+] d: detach · t: toggle control · ]: send ^]");
                continue;
            }
            if (byte === CTRL_RBRACKET) {
                flushOut();
                chordPending = true;
                writeTitle("Ctrl+] waiting: d detach · t toggle · ] send ^]");
                chordTimer = setTimeout(() => {
                    if (chordPending) {
                        chordPending = false;
                        detach();
                    }
                }, CHORD_TIMEOUT_MS);
                chordTimer.unref?.();
                continue;
            }
            pendingOut.push(byte);
        }
        flushOut();
    };

    const onResize = () => sendCurrentSize();
    const wasRaw = stdinTty.isRaw === true;
    if (typeof stdinTty.setRawMode === "function") {
        stdinTty.setRawMode(true);
    }
    stdinTty.resume();
    options.stdin.on("data", onStdinData);
    options.stdin.on("end", detach);
    options.stdin.on("close", detach);
    process.on("SIGWINCH", onResize);

    try {
        let gapCount = 0;
        let gapWindowStart = Date.now();
        while (!detaching) {
            latestSeq = 0;
            stream = await options.transport.attach({
                fromSeq: 0,
                generation: session.generation,
                ...(controlling ? { takeover: true } : {}),
                terminalId: session.terminalId,
            });
            const seed = await stream.next();
            if (seed.kind !== "seed") {
                throw new Error("Terminal stream seed is missing.");
            }
            session = seed.session;
            latestSeq = seed.snapshot?.seq ?? 0;
            writeTitle();
            if (seed.snapshot !== undefined) {
                options.stdout.write(seed.snapshot.data);
            }
            if (controlling) sendCurrentSize();

            let reconnectOnGap = false;
            while (!detaching) {
                const message = await stream.next();
                if (message.kind === "output") {
                    if (message.frame.seq <= latestSeq) continue;
                    latestSeq = message.frame.seq;
                    options.stdout.write(message.frame.data);
                    await stream.ack(session, latestSeq);
                    continue;
                }
                if (
                    message.kind === "inputAccepted" ||
                    message.kind === "resized"
                ) {
                    session = { ...session, version: message.identity.version };
                    if (message.kind === "resized") {
                        session = {
                            ...session,
                            cols: stdoutTty.columns ?? session.cols,
                            rows: stdoutTty.rows ?? session.rows,
                        };
                        writeTitle();
                    }
                    continue;
                }
                if (message.kind === "controlChanged") {
                    session = message.session;
                    const pending = pendingControls.get(message.clientSeq);
                    if (message.error !== undefined) {
                        if (pending !== undefined) {
                            pendingControls.delete(message.clientSeq);
                            pending.reject(new Error(message.error));
                        }
                        continue;
                    }
                    if (message.snapshot !== undefined) {
                        latestSeq = Math.max(latestSeq, message.snapshot.seq);
                        options.stdout.write(message.snapshot.data);
                    }
                    if (pending !== undefined) {
                        pendingControls.delete(message.clientSeq);
                        pending.resolve(message.humanControl);
                    }
                    continue;
                }
                if (message.kind === "exit") {
                    options.stderr.write(
                        `\r\n[terminal exited: code=${message.event.exitCode}${message.event.signal ? ` signal=${message.event.signal}` : ""}]\r\n`,
                    );
                    detaching = true;
                    break;
                }
                if (message.kind === "closed") {
                    for (const pending of pendingControls.values()) {
                        pending.reject(
                            message.error ??
                                new Error("Terminal stream closed."),
                        );
                    }
                    pendingControls.clear();
                    if (
                        !detaching &&
                        message.error !== undefined &&
                        isStreamGapError(message.error)
                    ) {
                        const now = Date.now();
                        if (now - gapWindowStart > GAP_WINDOW_MS) {
                            gapWindowStart = now;
                            gapCount = 0;
                        }
                        gapCount += 1;
                        if (gapCount > MAX_GAP_RECONNECTS) {
                            throw message.error;
                        }
                        reconnectOnGap = true;
                    } else if (!detaching && message.error !== undefined) {
                        throw message.error;
                    }
                    break;
                }
            }
            if (!reconnectOnGap) break;
        }
    } finally {
        clearTimeout(chordTimer);
        process.off("SIGWINCH", onResize);
        options.stdin.off("data", onStdinData);
        options.stdin.off("end", detach);
        options.stdin.off("close", detach);
        if (typeof stdinTty.setRawMode === "function") {
            stdinTty.setRawMode(wasRaw);
        }
        stdinTty.pause();
        stream?.close();
        options.stdout.write(FULL_TERMINAL_RESET);
    }
}

function isStreamGapError(error: Error): boolean {
    return (
        "code" in error &&
        (error as { code?: unknown }).code === STREAM_GAP_CODE
    );
}
