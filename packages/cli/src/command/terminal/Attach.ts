import {
    STREAM_GAP_CODE,
    type TerminalAttachment,
    type TerminalSessionDescriptor,
    type TerminalTransport,
} from "@portable-devshell/shared";

const CTRL_RBRACKET = 0x1d;
const CHORD_TIMEOUT_MS = 300;

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
    const pendingControls = new Map<
        number,
        { reject(error: Error): void; resolve(humanControl: boolean): void }
    >();

    const writeTitle = () => {
        const mode = controlling ? "[CONTROL]" : "[OBSERVE]";
        const label =
            session.name !== undefined && session.name.length > 0
                ? session.name
                : session.terminalId.slice(0, 16);
        const hint = controlling
            ? "Ctrl+] d detach | Ctrl+] t observe"
            : "read-only | Ctrl+] t takeover | Ctrl+] d detach";
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
                options.stderr.write(`\r\n[terminal] ${message}\r\n`);
            }
        });
    };

    const forwardInput = (bytes: Buffer) => {
        if (bytes.length === 0) return;
        if (!controlling) {
            options.stdout.write("\x07");
            return;
        }
        const text = bytes.toString("utf8");
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
                if (byte === 0x64 || byte === 0x44) {
                    // d / D -> detach
                    detach();
                    return;
                }
                if (byte === 0x74 || byte === 0x54) {
                    // t / T -> toggle observe/control
                    flushOut();
                    toggleControl();
                    continue;
                }
                if (byte === CTRL_RBRACKET) {
                    // ] -> send literal Ctrl+]
                    pendingOut.push(CTRL_RBRACKET);
                    continue;
                }
                // Any other key after Ctrl+] detaches immediately (preserving bare Ctrl+] ergonomics).
                detach();
                return;
            }
            if (byte === CTRL_RBRACKET) {
                flushOut();
                chordPending = true;
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
    process.on("SIGWINCH", onResize);

    try {
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
                    if (message.snapshot !== undefined) {
                        latestSeq = Math.max(latestSeq, message.snapshot.seq);
                        options.stdout.write(message.snapshot.data);
                    }
                    const pending = pendingControls.get(message.clientSeq);
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
        if (typeof stdinTty.setRawMode === "function") {
            stdinTty.setRawMode(wasRaw);
        }
        stdinTty.pause();
        stream?.close();
        options.stdout.write("\u001B]0;\u0007");
    }
}

function isStreamGapError(error: Error): boolean {
    return (
        "code" in error &&
        (error as { code?: unknown }).code === STREAM_GAP_CODE
    );
}
