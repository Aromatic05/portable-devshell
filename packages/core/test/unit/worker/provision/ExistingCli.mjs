// Isolated provider boundary: all containers, faults and worker files live next
// to this executable. This fixture never invokes Docker or Podman.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
const root = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const read = (name, initial) => fs.existsSync(path.join(root, name)) ? JSON.parse(fs.readFileSync(path.join(root, name), "utf8")) : initial;
const save = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value));
const fail = (message, code = 125) => { fs.writeSync(2, message); process.exit(code); };
const operation = args[0];
fs.appendFileSync(path.join(root, "calls.jsonl"), JSON.stringify(args) + "\n");
const faults = read("faults.json", []);
const faultIndex = faults.findIndex((fault) => fault.operation === operation);
if (faultIndex !== -1) {
    const [fault] = faults.splice(faultIndex, 1);
    save("faults.json", faults);
    if (fault.gate) {
        fs.writeFileSync(path.join(root, "gate-entered"), "");
        const deadline = Date.now() + 10000;
        while (!fs.existsSync(path.join(root, "gate-release"))) {
            if (Date.now() > deadline) fail("fixture gate timed out", 98);
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
    }
    if (fault.code) fail("injected " + operation + " failure", fault.code);
}
const containers = read("containers.json", {});
const target = operation === "exec" ? args[2 + args.slice(2).filter((arg) => arg === "-e").length * 2] : args.at(-1);
const entry = Object.entries(containers).find(([name, container]) => name === target || container.Id === target);
if (!entry) fail("no such container: " + target);
const [, container] = entry;
if (operation === "inspect") {
    fs.writeSync(1, JSON.stringify([container]));
} else if (operation === "start" || operation === "stop") {
    container.State.Status = operation === "start" ? "running" : "stopped";
    if (operation === "start") container.State.StartedAt = new Date().toISOString();
    save("containers.json", containers);
} else if (operation === "exec") {
    if (container.State.Status !== "running") fail("container stopped");
    const replacementFile = path.join(root, "replace-before-exec.json");
    if (fs.existsSync(replacementFile)) {
        containers.previous = container;
        containers.configured = JSON.parse(fs.readFileSync(replacementFile, "utf8"));
        save("containers.json", containers);
        fs.unlinkSync(replacementFile);
    }
    let cursor = 2;
    const environment = { ...process.env, HOME: path.join(root, "container-home"), USERPROFILE: path.join(root, "container-home") };
    for (const key of ["DEVSHELL_WORKER_INTERNAL_INSTANCE", "DEVSHELL_WORKER_INTERNAL_WORKSPACE", "DEVSHELL_WORKER_INTERNAL_SECURITY_MODE"]) delete environment[key];
    while (args[cursor] === "-e") cursor += 2;
    cursor++;
    const command = args[cursor];
    const commandArgs = args.slice(cursor + 1);
    // Avoid a login profile resetting the isolated HOME.
    const child = command === "sh" && commandArgs[0] === "-lc"
        ? spawn("/bin/sh", ["-c", commandArgs[1]], { env: environment, stdio: "inherit" })
        : spawn(command, commandArgs, { env: environment, stdio: "inherit" });
    child.once("error", (error) => fail(error.message, 127));
    process.exitCode = await new Promise((resolve) => child.once("close", resolve));
} else fail("unsupported isolated provider operation: " + operation, 97);
