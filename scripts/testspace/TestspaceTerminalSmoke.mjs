import { withTestspaceControlConnection } from "./TestspaceReverse.mjs";

export async function runTestspaceTerminalSmoke({ runtimeDirectory, targets }) {
    const results = [];
    for (const target of targets) {
        results.push(await smokeTerminal(target, runtimeDirectory));
    }
    return results;
}

async function smokeTerminal(target, runtimeDirectory) {
    const { instance, workspace } = target;
    return await withTestspaceControlConnection(runtimeDirectory, async (_shared, connection) => {
        const opened = await connection.request(instance, "terminal", "open", {
            cols: 80,
            rows: 24,
            workspace,
        });
        let version = opened.version;
        let lastSeq = 0;
        let clientSeq = 0;
        const attached = await connection.openStream(instance, "terminal", "attach", {
            fromSeq: 0,
            generation: opened.generation,
            terminalId: opened.terminalId,
        });
        const readyMarker = `${instance}-terminal-ready`;
        await attached.stream.send("input", {
            clientSeq: ++clientSeq,
            data: terminalPrintCommand(readyMarker),
            generation: opened.generation,
            terminalId: opened.terminalId,
            version,
        });
        const ready = await waitForTerminal(attached.stream, {
            generation: opened.generation,
            label: `${instance}:initial-output`,
            marker: readyMarker,
            terminalId: opened.terminalId,
            version: () => version,
        });
        lastSeq = Math.max(lastSeq, ready.lastSeq);

        await attached.stream.send("resize", {
            clientSeq: ++clientSeq,
            cols: 100,
            generation: opened.generation,
            rows: 40,
            terminalId: opened.terminalId,
            version,
        });
        const resized = await waitForTerminal(attached.stream, {
            generation: opened.generation,
            label: `${instance}:resize`,
            predicate: (event) =>
                event.name === "terminal.resized" &&
                event.payload?.clientSeq === clientSeq,
            terminalId: opened.terminalId,
            version: () => version,
        });
        version = resized.event.payload.version;
        lastSeq = Math.max(lastSeq, resized.lastSeq);

        await attached.stream.send("input", {
            clientSeq: ++clientSeq,
            data: terminalSizeProbeCommand(),
            generation: opened.generation,
            terminalId: opened.terminalId,
            version,
        });
        const sized = await waitForTerminal(attached.stream, {
            generation: opened.generation,
            label: `${instance}:size-probe`,
            marker: terminalExpectedSize(40, 100),
            terminalId: opened.terminalId,
            version: () => version,
        });
        lastSeq = Math.max(lastSeq, sized.lastSeq);
        attached.stream.close();

        const resumed = await connection.openStream(instance, "terminal", "attach", {
            fromSeq: lastSeq,
            generation: opened.generation,
            terminalId: opened.terminalId,
        });
        const resumedMarker = `${instance}-terminal-resumed`;
        await resumed.stream.send("input", {
            clientSeq: ++clientSeq,
            data: terminalPrintCommand(resumedMarker),
            generation: opened.generation,
            terminalId: opened.terminalId,
            version,
        });
        const resumedResult = await waitForTerminal(resumed.stream, {
            generation: opened.generation,
            label: `${instance}:resume`,
            marker: resumedMarker,
            terminalId: opened.terminalId,
            version: () => version,
        });
        lastSeq = Math.max(lastSeq, resumedResult.lastSeq);
        resumed.stream.close();

        const killed = await connection.request(instance, "terminal", "kill", {
            generation: opened.generation,
            terminalId: opened.terminalId,
            version,
        });
        if (killed.state !== "killed" && killed.state !== "exited") {
            throw new Error(`terminal kill failed for ${instance}: ${JSON.stringify(killed)}`);
        }
        return {
            instance,
            lastSeq,
            resized: `${killed.rows}x${killed.cols}`,
            state: killed.state,
            terminalId: opened.terminalId,
        };
    });
}

async function waitForTerminal(stream, options) {
    const deadline = Date.now() + 15_000;
    let output = "";
    let lastSeq = 0;
    let lastEvent;
    while (Date.now() < deadline) {
        const remaining = Math.max(1, deadline - Date.now());
        let event;
        try {
            event = await Promise.race([
                stream.nextEvent(),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error("terminal event timeout")), remaining),
                ),
            ]);
        } catch (error) {
            throw new Error(
                `${options.label} failed: ${error instanceof Error ? error.message : String(error)}; ` +
                    `lastEvent=${lastEvent?.name ?? "none"}; output=${JSON.stringify(output)}`,
            );
        }
        lastEvent = event;
        if (event.name === "stream.cancelled" || event.name === "stream.completed") {
            throw new Error(
                `${options.label} ended unexpectedly: ${event.name}; ` +
                    `error=${JSON.stringify(event.error)}; output=${JSON.stringify(output)}`,
            );
        }
        if (event.name === "terminal.output") {
            const seq = event.payload?.seq ?? 0;
            output += event.payload?.data ?? "";
            lastSeq = Math.max(lastSeq, seq);
            await stream.send("ack", {
                generation: options.generation,
                terminalId: options.terminalId,
                throughSeq: seq,
                version: options.version(),
            });
        }
        const matched = options.predicate?.(event, output) ??
            (options.marker !== undefined && output.includes(options.marker));
        if (matched) return { event, lastSeq, output };
    }
    throw new Error(
        `${options.label} failed; terminal=${options.terminalId}; last event=${lastEvent?.name ?? "none"}; output=${JSON.stringify(output)}`,
    );
}

function terminalPrintCommand(marker) {
    const split = Math.max(1, Math.floor(marker.length / 2));
    const left = marker.slice(0, split).replaceAll("'", "");
    const right = marker.slice(split).replaceAll("'", "");
    return process.platform === "win32"
        ? `powershell.exe -NoLogo -NoProfile -NonInteractive -Command "[Console]::WriteLine(('${left}' + '${right}'))"\r`
        : `printf '%s%s\\n' '${left}' '${right}'\r`;
}

function terminalSizeProbeCommand() {
    return process.platform === "win32"
        ? `powershell.exe -NoLogo -NoProfile -NonInteractive -Command "$s=$Host.UI.RawUI.WindowSize; [Console]::WriteLine(('{0} {1}' -f $s.Height,$s.Width))"\r`
        : "stty size\r";
}

function terminalExpectedSize(rows, cols) {
    return `${rows} ${cols}`;
}
