import { writeFile } from "node:fs/promises";

const [url, output] = process.argv.slice(2);
if (url === undefined || output === undefined) {
    process.stderr.write("Usage: DownloadWorker <url> <output>\n");
    process.exitCode = 2;
} else {
    try {
        const response = await fetch(url, {
            headers: { "user-agent": "portable-devshell-access" },
            redirect: "follow",
            signal: AbortSignal.timeout(120_000),
        });
        if (!response.ok)
            throw new Error(`HTTP ${response.status} ${response.statusText}`);
        await writeFile(output, Buffer.from(await response.arrayBuffer()), {
            mode: 0o600,
        });
    } catch (error) {
        process.stderr.write(
            `${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exitCode = 1;
    }
}
