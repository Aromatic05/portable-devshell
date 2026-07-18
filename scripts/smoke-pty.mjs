import { writeSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { waitForPtyMarker } from "./PtySmoke.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const requireFromTui = createRequire(resolve(repositoryRoot, "packages", "tui", "package.json"));
const { spawn } = requireFromTui("node-pty");
const marker = "native-pty-ok";
const shell = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "/bin/sh";
const args = process.platform === "win32" ? ["/d", "/s", "/c", `echo ${marker}`] : ["-c", `printf ${marker}`];

try {
    const pty = spawn(shell, args, { cols: 80, rows: 24 });
    await waitForPtyMarker(pty, marker);
    writeSync(process.stdout.fd, "native PTY smoke passed\n");
    process.exit(0);
} catch (error) {
    writeSync(process.stderr.fd, `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
}
