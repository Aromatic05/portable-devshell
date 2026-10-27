// Read one prompt answer without taking ownership of the stream or consuming
// pasted answers belonging to a delegated command. Keep the remainder in the
// original Readable so the existing terminal relay remains the only consumer.
export function readCommandLine(input: NodeJS.ReadableStream): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        const cleanup = () => {
            input.off("readable", read);
            input.off("end", end);
            input.off("error", fail);
        };
        const end = () => {
            cleanup();
            resolve(Buffer.concat(chunks).toString("utf8"));
        };
        const fail = (error: Error) => {
            cleanup();
            reject(error);
        };
        const read = () => {
            let chunk: string | Buffer | null;
            while ((chunk = input.read()) !== null) {
                const bytes = Buffer.isBuffer(chunk)
                    ? chunk
                    : Buffer.from(chunk);
                const newline = bytes.indexOf(10);
                if (newline < 0) {
                    chunks.push(bytes);
                    continue;
                }
                chunks.push(bytes.subarray(0, newline));
                if (newline + 1 < bytes.length)
                    input.unshift(bytes.subarray(newline + 1));
                end();
                return;
            }
            if ("readableEnded" in input && input.readableEnded === true) end();
        };
        input.on("readable", read);
        input.once("end", end);
        input.once("error", fail);
        read();
    });
}
