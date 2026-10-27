import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { createRequire } from "node:module";
import { TuiRuntime } from "../../src/app/Runtime.ts";
import { TuiTerminalSession } from "../../src/terminal/emulation/Session.ts";
import { TuiTerminalBuffer } from "../../src/terminal/emulation/Buffer.ts";
import { currentTuiRoute, selectMainScreenModel, selectMainScrollKey } from "../../src/testing.ts";
import { readContextMessageDraft } from "../../src/state/editor/MessageDraft.ts";
import { TuiDomainHarness } from "../support/DomainHarness.ts";
import { mainContentWidth } from "../../src/view/shell/Layout.tsx";

const pause = (ms = 60) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(predicate: () => boolean) {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
        assert.ok(Date.now() < deadline, "TUI state timed out");
        await pause(5);
    }
}

async function launch(columns: number, rows: number) {
    // Ink uses a shared Chalk instance; enable terminal styles for this in-memory TTY.
    const requireInk = createRequire(createRequire(import.meta.url).resolve("ink"));
    const chalk = (await import(requireInk.resolve("chalk"))).default;
    const colorLevel = chalk.level;
    chalk.level = 1;
    class Input extends PassThrough {
        isTTY = true;
        setRawMode() { return this; }
        ref() { return this; }
        unref() { return this; }
    }
    const stdin = new Input();
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns, rows });
    let output = "";
    stdout.on("data", (data) => { output += data.toString(); });
    const now = new Date().toISOString();
    const fixture = new TuiDomainHarness({
        instanceList: [
            { name: "alpha", enabled: true, mcpEnabled: true, homeDirectory: "/review/home" },
            { name: "beta", enabled: false, mcpEnabled: false, homeDirectory: "/review/beta" },
        ],
        configView: { instances: [
            { name: "alpha", provider: "local", mcp: { auth: { mode: "none" } } },
            { name: "beta", provider: "local", mcp: { auth: { mode: "none" } } },
        ] },
        contextRecords: [{ ctxId: "old", createdAt: now, lastAccessedAt: now,
            environments: [{ instance: "alpha", workspace: "/review/work" }], status: "active" }] as never,
    });
    const domains = fixture.value;
    const historySource = domains.messageHistory as unknown as {
        patch: (state: { context?: unknown }) => void;
    };
    domains.messageHistory.loadContext = async (instance: string, ctxId: string) => {
        historySource.patch({ context: { instance, ctxId, loading: false, historyExhausted: true,
            entries: [{ id: "history", ctxId, kind: "report", createdAt: now,
                text: Array.from({ length: 30 }, (_, index) => `history-${index}`).join("\n") }] } });
    };
    domains.messageHistory.clearContext = () => historySource.patch({ context: undefined });
    const queued: unknown[][] = [];
    const messages = domains.messages as unknown as {
        queue: (...args: unknown[]) => Promise<unknown>;
    };
    messages.queue = async (...args: unknown[]) => { queued.push(args); return {}; };
    const terminal = new TuiTerminalSession({ ptyFactory: () => ({
        kill() {}, resize() {}, write() {},
        onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; },
    }) });
    const runtime = new TuiRuntime({ stdin: stdin as never, stdout: stdout as never }, { domains, terminal });
    const running = runtime.run();
    await until(() => runtime.store.getState().connection.status === "connected");
    await pause();
    return {
        runtime, fixture, queued,
        async key(raw: string) { stdin.write(raw); await pause(); },
        async screen() {
            await pause();
            const buffer = new TuiTerminalBuffer({ columns, rows });
            try {
                await buffer.write(output.replace(/(?<!\r)\n/gu, "\r\n"));
                return buffer.getSnapshot();
            } finally { buffer.dispose(); }
        },
        async close() { await runtime.stop(); await running; stdin.destroy(); stdout.destroy(); chalk.level = colorLevel; },
    };
}

for (const [columns, rows] of [[80, 20], [120, 40]]) {
    test(`D01 real Ink composer follows pasted and edited cursor without covering border ${columns}x${rows}`, async () => {
        const h = await launch(columns, rows);
        try {
            const r = h.runtime;
            r.store.setSelectedInstance("alpha");
            await h.key("4");
            for (let index = 0; index < 5; index++) await h.key("\x1b[B");
            await h.key("\r");
            assert.equal(currentTuiRoute(r.store.getState()).view, "thread");
            await until(() => r.store.getState().interaction.focusScope === "contextMessage");
            const draft = `BEGIN-DRAFT\n${Array.from({ length: 12 }, (_, index) => `paragraph-${index}`).join("\n")}\nTAIL-DRAFT`;
            await h.key(`\x1b[200~${draft}\x1b[201~`);
            await h.key("Z");
            assert.equal(readContextMessageDraft(r.store.getState(), "alpha", "old"), `${draft}Z`);
            assert.deepEqual(h.queued, []);
            const snapshot = await h.screen();
            const tail = snapshot.lines.find((line) => line.segments.some((segment) => segment.text.includes("TAIL-DRAFTZ")));
            assert.ok(tail, "edited draft tail must be visible");
            assert.ok(tail.segments.some((segment) => segment.underline), "cursor cell must be visible beside the tail");
            assert.match(snapshot.lines[rows - 5]!.segments.map((segment) => segment.text).join(""), /└─+┘/u);
            const scrollKey = selectMainScrollKey(r.store.getState());
            const cursor = r.store.getState().interaction.editor!.cursor;
            await h.key("\x1b[5~");
            const older = r.store.getState().ui.scrollOffsets[scrollKey]!;
            await h.key("\x1b[6~");
            assert.ok(r.store.getState().ui.scrollOffsets[scrollKey]! > older);
            assert.equal(r.store.getState().interaction.editor!.cursor, cursor);
            assert.ok((await h.screen()).lines.some((line) => line.segments.some((segment) => segment.text.includes("TAIL-DRAFTZ"))));
            await h.key("\x1b[D");
            const left = (await h.screen()).lines.flatMap((line) => line.segments);
            assert.ok(left.some((segment) => segment.underline && segment.text === "Z"));
            await h.key("\x1b[D".repeat(draft.length));
            await until(() => r.store.getState().interaction.editor!.cursor === 0);
            const head = (await h.screen()).lines.find((line) => line.segments.some((segment) => segment.text.includes("EGIN-DRAFT")));
            assert.ok(head, "moving to the head must move the composer window");
            assert.ok(head.segments.some((segment) => segment.underline && segment.text === "B"));
            await h.key("\x1b[C".repeat(draft.length));
            await until(() => r.store.getState().interaction.editor!.cursor === draft.length);
            await h.key("\x7f");
            assert.equal(readContextMessageDraft(r.store.getState(), "alpha", "old"), `${draft.slice(0, -1)}Z`);
            await h.key("\r");
            assert.deepEqual(h.queued, [["alpha", "old", `${draft.slice(0, -1)}Z`]]);
            assert.equal(readContextMessageDraft(r.store.getState(), "alpha", "old"), "");
            // At an exact terminal-width boundary the end cursor needs its own row.
            const width = mainContentWidth(columns) - 2;
            const wrapped = "界".repeat(Math.floor(width / 2)) + "x".repeat(width % 2);
            await h.key(`\x1b[200~${wrapped}\x1b[201~`);
            const boundary = await h.screen();
            assert.ok(boundary.lines.some((line) => line.segments.map((segment) => segment.text).join("").includes(wrapped)));
            const endCursor = boundary.lines.findIndex((line) => line.segments.some((segment) => segment.underline));
            const bodyRow = boundary.lines.findIndex((line) => line.segments.some((segment) => segment.text.includes("界")));
            assert.equal(endCursor, bodyRow + 1);
            await h.key("\x1b[D");
            await h.key("\x7f");
            assert.equal(readContextMessageDraft(r.store.getState(), "alpha", "old"),
                "界".repeat(Math.floor(width / 2) - 1) + "x".repeat(width % 2));
            await h.key("\x1b[C");
            await h.key("\x1b[200~\n\n中e\u0301  TAIL-WRAP  \x1b[201~");
            const currentDraft = readContextMessageDraft(r.store.getState(), "alpha", "old");
            assert.equal(r.store.getState().interaction.editor!.cursor, currentDraft.length);
            const unicodeTail = (await h.screen()).lines.find((line) => line.segments.some((segment) => segment.text.includes("中e\u0301  TAIL-WRAP  ")));
            assert.ok(unicodeTail, "blank lines, combining graphemes and spaces must survive wrapping");
            assert.ok(unicodeTail.segments.some((segment) => segment.underline && segment.text === " "));
            assert.equal(h.queued.length, 1, "wrapped paste must not auto-send");
        } finally { await h.close(); }
    });

    test(`D02 real Ink ordinary detail keeps selected action visible and confirmation safe ${columns}x${rows}`, async () => {
        const h = await launch(columns, rows);
        try {
            const r = h.runtime;
            await h.key("1"); await h.key("\t"); await h.key("\x1b[B"); await h.key("\r");
            const box = selectMainScreenModel(r.store.getState(), r.reader).boxes.find((item) => item.id === "instance:alpha")!;
            assert.equal(box.selectedDetailLineId, "instance:alpha:instance.toggleEnabled:alpha");
            const enabled = (await h.screen()).lines.find((line) => line.segments.some((segment) => segment.text.includes("enabled")));
            assert.ok(enabled, "the action activated by Enter must be visible");
            assert.ok(enabled.segments.some((segment) => segment.backgroundColor === "#00cdcd"));
            await h.key("\r");
            const overlay = r.store.getState().interaction.overlays.at(-1);
            assert.equal(overlay?.kind, "confirmation");
            assert.match((overlay as { title: string }).title, /Disable/u);
            // Enter on the default choice cancels; it must never disable the fixture instance.
            await h.key("\r");
            assert.equal(r.store.getState().interaction.overlays.length, 0);
            for (const label of ["provider", "home"]) {
                await h.key("\x1b[B");
                const selected = selectMainScreenModel(r.store.getState(), r.reader).boxes.find((item) => item.id === box.id)!;
                assert.ok(selected.selectedDetailLineId?.endsWith(`:${label}`));
                const expected = selected.expandedLines.find((line) => line.id === selected.selectedDetailLineId)!.text;
                const row = (await h.screen()).lines.find((line) => line.segments.map((segment) => segment.text).join("").includes(expected));
                assert.ok(row, `${label} must stay in the viewport`);
                assert.ok(row.segments.some((segment) => segment.backgroundColor === "#00cdcd"), JSON.stringify({ label, segments: row.segments }));
            }
            await h.key("\x1b[6~");
            await h.key("\x1b[B");
            const afterPage = selectMainScreenModel(r.store.getState(), r.reader).boxes.find((item) => item.id === box.id)!;
            const selectedText = afterPage.expandedLines.find((line) => line.id === afterPage.selectedDetailLineId)!.text;
            assert.ok((await h.screen()).lines.some((line) =>
                line.segments.map((segment) => segment.text).join("").includes(selectedText) &&
                line.segments.some((segment) => segment.backgroundColor === "#00cdcd")));
            assert.deepEqual(h.fixture.lifecycleActions(), []);
        } finally { await h.close(); }
    });
}
