// Copied into each temporary root and launched as a real executable. No Podman
// daemon or SSH server is involved; state and all remote files stay in that root.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
const filename = fileURLToPath(import.meta.url);
const root = path.dirname(filename);
const args = process.argv.slice(2);
// Real remote login/container environments do not inherit host worker internals.
for (const key of ["DEVSHELL_WORKER_INTERNAL_INSTANCE", "DEVSHELL_WORKER_INTERNAL_WORKSPACE", "DEVSHELL_WORKER_INTERNAL_SECURITY_MODE"]) delete process.env[key];
const ssh = path.basename(filename).includes("ssh");
const log = (entry) => fs.appendFileSync(path.join(root, "calls.jsonl"), JSON.stringify(entry) + "\n");
const read = (file, initial) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : initial;
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
const fail = (message, code) => { fs.writeSync(2, message + "\n"); process.exit(code); };

async function main() {
    let uploadInput;
    const operation = ssh ? "ssh" : args[0];
    const name = args[0] === "create" ? args[args.indexOf("--name") + 1] : args.at(-1);
    log({ operation, name, args });
    const faultFile = path.join(root, "faults.json");
    const faults = read(faultFile, []);
    const index = faults.findIndex((fault) => fault.operation === operation &&
        (fault.name === undefined || fault.name === name) &&
        (fault.contains === undefined || args.join(" ").includes(fault.contains)));
    if (index !== -1) {
        const fault = faults[index];
        faults.splice(index, 1);
        save(faultFile, faults);
        if (fault.gate) {
            fs.writeFileSync(path.join(root, "gate-entered"), "");
            const deadline = Date.now() + 5000;
            while (!fs.existsSync(path.join(root, "gate-release"))) {
                if (Date.now() > deadline) fail("fixture gate deadline exceeded", 98);
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
        }
        if (fault.signal) {
            process.kill(process.pid, fault.signal);
            return;
        }
        if (fault.corruptUpload) uploadInput = Buffer.concat([fs.readFileSync(0), Buffer.from("corrupted-in-transit")]);
        if (fault.code) fail(fault.message, fault.code);
    }
    if (ssh) {
        const separator = args.indexOf("--");
        if (separator === -1 || args[separator + 1] !== "sh" || args[separator + 2] !== "-lc")
            fail("fixture expected SSH remote shell envelope", 97);
        // The fake transport has no login account. Keep HOME isolated instead of
        // allowing the host's login profile to reset it. Inner sh uses the shim.
        const command = args.at(-1).replaceAll("/tmp/portable-devshell-env-", root + "/remote-tmp/portable-devshell-env-");
        await execute("/bin/sh", ["-c", "exec sh -c " + command], {
            ...process.env, HOME: path.join(root, "remote-home"),
            PATH: path.join(root, "bin") + ":" + process.env.PATH,
        }, uploadInput);
        return;
    }
    const stateFile = path.join(root, "containers.json");
    const state = read(stateFile, {});
    switch (operation) {
        case "inspect":
            if (!state[name]) fail("Error: no such container: " + name, 125);
            fs.writeSync(1, state[name].status + "\n");
            return;
        case "create":
            if (state[name]) fail("container name is already in use", 125);
            state[name] = { status: "stopped", args };
            break;
        case "start":
        case "stop":
            if (!state[name]) fail("Error: no such container: " + name, 125);
            state[name].status = operation === "start" ? "running" : "stopped";
            break;
        case "rm":
            delete state[name];
            break;
        case "exec": {
            let cursor = 2;
            const environment = { ...process.env };
            const keys = [];
            while (args[cursor] === "-e") {
                keys.push(args[cursor + 1]);
                cursor += 2;
            }
            const container = args[cursor++];
            if (state[container]?.status !== "running") fail("container is not running", 125);
            // Only declared keys are forwarded to the fake container process.
            for (const key of Object.keys(environment)) {
                if (key.startsWith("ROUND6_") && !keys.includes(key)) delete environment[key];
            }
            log({ operation: "worker", name: container, args: args.slice(cursor), keys });
            await execute(args[cursor], args.slice(cursor + 1), environment);
            return;
        }
        default:
            fail("unsupported fake CLI operation: " + operation, 96);
    }
    save(stateFile, state);
}

async function execute(command, commandArgs, env, input) {
    const child = spawn(command, commandArgs, { env, stdio: input === undefined ? "inherit" : ["pipe", "inherit", "inherit"] });
    if (input !== undefined) child.stdin.end(input);
    child.once("error", (error) => fail(error.message, 127));
    const code = await new Promise((resolve) => child.once("close", resolve));
    process.exitCode = code ?? 128;
}

main().catch((error) => fail(error.stack, 99));
