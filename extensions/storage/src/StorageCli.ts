import { executeStorageArguments } from "./builtin/StorageCommandCore.js";

try {
    const result = executeStorageArguments(process.argv.slice(2), {
        signal: new AbortController().signal,
        workingDirectory: process.cwd(),
    });
    if (result.kind === "text") process.stdout.write(`${result.text}\n`);
    else process.stdout.write(`${JSON.stringify(result.value, null, 2)}\n`);
} catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
}
