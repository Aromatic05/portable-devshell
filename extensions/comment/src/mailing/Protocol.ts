import { createHash } from "node:crypto";

export interface Mail {
    readonly id: string;
    readonly from: string;
    readonly to: readonly string[];
    readonly subject: string;
    readonly inReplyTo?: string;
    readonly body: string;
    readonly fingerprint: string;
}

const START = "<!-- MAIL BEGIN -->";
const END = "<!-- MAIL END -->";
const TASK_NAME = /^[a-z0-9](?:[a-z0-9._-]{0,62})$/u;

export function taskName(value: string): string {
    if (!TASK_NAME.test(value) || value === "." || value === ".." || value === ".mailing")
        throw new Error(`Invalid Agent Work name: ${value}`);
    return value;
}

/** Only explicit, complete mail blocks are dispatched; existing chat prose is ignored. */
export function parseOutbox(source: string, sender: string, onError?: (error: unknown) => void): Mail[] {
    const from = taskName(sender);
    const lines = source.replace(/\r\n?/gu, "\n").split("\n");
    const messages: Mail[] = [];
    for (let start = 0; start < lines.length; start++) {
        if (lines[start] !== START) continue;
        const end = lines.indexOf(END, start + 1);
        if (end < 0) break; // A writer may still be composing this message.
        try {
            const raw = lines.slice(start + 1, end);
            const split = raw.indexOf("");
            if (split < 0) throw new Error(`Mail at ${from}:${start + 1} lacks a header separator`);
            const headers = new Map<string, string>();
            for (const line of raw.slice(0, split)) {
                const match = /^([A-Za-z-]+):[ \t]*(.*)$/u.exec(line);
                if (match === null) throw new Error(`Invalid mail header at ${from}:${start + 1}`);
                const key = match[1]!.toLowerCase();
                if (headers.has(key)) throw new Error(`Duplicate ${key} header at ${from}:${start + 1}`);
                headers.set(key, match[2]!);
            }
            const addressed = headers.get("to")?.split(",").map((name) => name.trim());
            const subject = headers.get("subject")?.trim();
            const reply = headers.get("in-reply-to")?.trim();
            if (addressed === undefined || addressed.length === 0 || addressed.length > 32 ||
                addressed.some((name) => name !== "*" && !TASK_NAME.test(name)))
                throw new Error(`Invalid recipients at ${from}:${start + 1}`);
            if (subject === undefined || subject.length === 0 || subject.length > 180)
                throw new Error(`Invalid Subject at ${from}:${start + 1}`);
            if (reply !== undefined && reply !== "none" && !/^[a-z0-9][a-z0-9._-]{0,62}#[1-9][0-9]*$/u.test(reply))
                throw new Error(`Invalid In-Reply-To at ${from}:${start + 1}`);
            const body = raw.slice(split + 1).join("\n").trimEnd();
            if (Buffer.byteLength(body, "utf8") > 128 * 1024)
                throw new Error(`Mail at ${from}:${start + 1} exceeds 128 KiB`);
            const id = `${from}#${start + 1}`;
            messages.push({
                id, from, to: [...new Set(addressed)], subject, body,
                ...(reply === undefined || reply === "none" ? {} : { inReplyTo: reply }),
                fingerprint: createHash("sha256").update(lines.slice(start, end + 1).join("\n")).digest("hex"),
            });
        } catch (error) {
            if (onError === undefined) throw error;
            onError(error);
        }
        start = end;
    }
    return messages;
}

export function mailMarker(id: string): string {
    return `<!-- MAIL ID ${id} -->`;
}

/** A length-delimited record keeps even complete quoted records inside the body. */
function frame(content: string): string {
    const payload = content.trimEnd();
    const lines = payload.split("\n").length;
    const digest = createHash("sha256").update(payload).digest("hex");
    return `<!-- MAIL RECORD ${lines} ${digest} -->\n${payload}\n<!-- END MAIL RECORD -->\n`;
}

export function hasMailRecord(source: string, marker: string, expected: string): boolean {
    const lines = source.replace(/\r\n?/gu, "\n").split("\n");
    let found = false;
    for (let index = 0; index < lines.length; index++) {
        const header = /^<!-- MAIL RECORD ([1-9][0-9]*) ([a-f0-9]{64}) -->$/u.exec(lines[index]!);
        if (header === null) continue;
        const count = Number(header[1]);
        const end = index + count + 1;
        const payload = lines.slice(index + 1, end).join("\n");
        if (!Number.isSafeInteger(count) || end >= lines.length ||
            lines[end] !== "<!-- END MAIL RECORD -->" ||
            createHash("sha256").update(payload).digest("hex") !== header[2])
            throw new Error("Corrupt Mailing record; refusing to acknowledge delivery");
        if (lines[index + 1] === marker) {
            if (lines.slice(index, end + 1).join("\n") + "\n" !== expected)
                throw new Error(`Mailing record changed after publication: ${marker}`);
            found = true;
        }
        index = end;
    }
    return found;
}

export function renderInbox(mail: Mail): string {
    return frame([
        mailMarker(mail.id),
        `From: ${mail.from}`,
        `To: ${mail.to.join(", ")}`,
        `Subject: ${mail.subject}`,
        ...(mail.inReplyTo === undefined ? [] : [`In-Reply-To: ${mail.inReplyTo}`]),
        "", mail.body, `<!-- END MAIL ID ${mail.id} -->`, "",
    ].join("\n"));
}

export function renderIndex(mail: Mail, recipients: readonly string[]): string {
    return frame([mailMarker(mail.id), `- ${mail.id} | ${mail.from} -> ${recipients.join(", ")} | ${mail.subject.replace(/[\r\n|]/gu, " ")}`, ""].join("\n"));
}

export function renderBounce(mail: Mail, recipient: string): string {
    return frame([
        mailMarker(`${mail.id}:bounce:${recipient}`),
        `From: mailer-daemon`,
        `To: ${mail.from}`,
        `Subject: Undeliverable: ${mail.subject}`,
        `In-Reply-To: ${mail.id}`,
        "", `Unknown Agent Work recipient: ${recipient}`, "",
    ].join("\n"));
}
