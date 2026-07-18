export async function waitForPtyMarker(pty, marker, timeoutMs = 10_000) {
    return await new Promise((resolve, reject) => {
        let output = "";
        let settled = false;
        let dataSubscription;
        let exitSubscription;

        const timeout = setTimeout(() => {
            finish(new Error(`node-pty smoke timed out: ${JSON.stringify(output)}`));
        }, timeoutMs);

        function finish(error) {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            dataSubscription?.dispose();
            exitSubscription?.dispose();
            try {
                pty.kill();
            } catch {
                // The PTY may already have exited after producing the marker.
            }
            if (error === undefined) {
                resolve(output);
            } else {
                reject(error);
            }
        }

        dataSubscription = pty.onData((data) => {
            output += data;
            if (output.includes(marker)) {
                finish();
            }
        });
        exitSubscription = pty.onExit(({ exitCode }) => {
            if (exitCode === 0 && output.includes(marker)) {
                finish();
                return;
            }
            finish(new Error(`node-pty smoke failed (${exitCode}): ${JSON.stringify(output)}`));
        });
    });
}
