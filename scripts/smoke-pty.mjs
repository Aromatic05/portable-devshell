import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const requireFromTui = createRequire(resolve(repositoryRoot, "packages", "tui", "package.json"));
const { spawn } = requireFromTui("node-pty");
const shell = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "/bin/sh";
const args = process.platform === "win32" ? ["/d", "/s", "/c", "echo native-pty-ok"] : ["-c", "printf native-pty-ok"];
const pty = spawn(shell, args, { cols: 80, rows: 24 });
let output = "";

pty.onData((data) => {
    output += data;
});
pty.onExit(({ exitCode }) => {
    if (exitCode !== 0 || !output.includes("native-pty-ok")) {
        throw new Error(`node-pty smoke failed (${exitCode}): ${JSON.stringify(output)}`);
    }
    process.stdout.write("native PTY smoke passed\n");
});
