// Dedicated, disposable migration fault-injection process. No product instance.
import { writeSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { betaOAuth } from "../support/BetaOAuth.ts";

const [directory, phase] = process.argv.slice(2);
if (!directory) throw new Error("Missing isolated migration test directory");
const pause = () => {
    writeSync(1, JSON.stringify({ checkpoint: phase }) + "\n");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};
const prepare = DatabaseSync.prototype.prepare;
let inserts = 0;
DatabaseSync.prototype.prepare = function (sql) {
    const statement = prepare.call(this, sql);
    if (phase === "partial" && /INSERT INTO oidc_records\b/u.test(sql)) {
        const run = statement.run;
        statement.run = function (...args: Array<SQLInputValue | Record<string, SQLInputValue>>) {
            const result = Reflect.apply(run, this, args) as ReturnType<typeof run>;
            if (++inserts === 2) pause();
            return result;
        };
    }
    return statement;
};
const exec = DatabaseSync.prototype.exec;
let commits = 0;
DatabaseSync.prototype.exec = function (sql) {
    const result = exec.call(this, sql);
    if (sql === "COMMIT" && ++commits === 2 && phase === "committed") pause();
    return result;
};
const runtime = betaOAuth(directory);
await runtime.warmup();
writeSync(1, JSON.stringify({ checkpoint: "open" }) + "\n");
