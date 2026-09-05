import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { TESTSPACE_REVERSE_INSTANCE } from "./TestspaceConfig.mjs";

const piEntry = fileURLToPath(
    new URL("../../packages/pi-extension/node_modules/@earendil-works/pi-coding-agent/dist/index.js", import.meta.url),
);
const extensionPath = fileURLToPath(
    new URL("../../packages/pi-extension/dist/index.js", import.meta.url),
);

export async function runTestspacePiStandaloneSmoke({ home, workspace, reverseWorkspace }) {
    const localProject = join(workspace, ".pi-standalone-smoke");
    const remoteProject = join(reverseWorkspace, ".pi-standalone-smoke");
    const agentDir = join(home, ".pi-standalone-smoke", "agent");
    const previousCwd = process.cwd();
    const previousTarget = process.env.DEVSHELL_AGENT_TARGET;
    const previousWorkspace = process.env.PORTABLE_DEVSHELL_PI_WORKSPACE;
    let session;

    try {
        await Promise.all([
            resetProject(localProject, "local-only", "LOCAL_CONTEXT_DECOY"),
            resetProject(remoteProject, "remote-v1", "REMOTE_CONTEXT_V1"),
            resetGlobalResources(agentDir),
        ]);

        process.env.PORTABLE_DEVSHELL_PI_WORKSPACE = localProject;
        process.env.DEVSHELL_AGENT_TARGET = `${TESTSPACE_REVERSE_INSTANCE}:${remoteProject}`;
        process.chdir(localProject);

        const pi = await import(pathToFileURL(piEntry).href);
        const settingsManager = pi.SettingsManager.inMemory(undefined, { projectTrusted: false });
        const resourceLoader = new pi.DefaultResourceLoader({
            additionalExtensionPaths: [extensionPath],
            agentDir,
            cwd: localProject,
            settingsManager,
        });
        await resourceLoader.reload();
        const sessionManager = pi.SessionManager.inMemory(localProject);
        const created = await pi.createAgentSession({
            agentDir,
            cwd: localProject,
            resourceLoader,
            sessionManager,
            settingsManager,
        });
        session = created.session;
        assert.deepEqual(created.extensionsResult.errors, []);
        await session.bindExtensions({ mode: "rpc", shutdownHandler: () => undefined });

        assert.equal(process.cwd(), localProject);
        assert.equal(sessionManager.getCwd(), localProject);
        assertRemoteCommands(session, "remote-v1");
        assertNativePiResources(resourceLoader);
        assertNoCommand(session, "local-only");
        assertNoCommand(session, "skill:local-only");

        await resetProject(remoteProject, "remote-v2", "REMOTE_CONTEXT_V2");
        await session.reload();

        assertRemoteCommands(session, "remote-v2");
        assertNativePiResources(resourceLoader);
        assertNoCommand(session, "remote-v1");
        assertNoCommand(session, "skill:remote-v1");
        assertNoCommand(session, "local-only");
        assertNoCommand(session, "skill:local-only");
        return {
            localProject,
            remoteProject,
            remoteVersion: "remote-v2",
            sessionCwd: sessionManager.getCwd(),
        };
    } finally {
        if (session !== undefined) {
            await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
            session.dispose();
        }
        process.chdir(previousCwd);
        restoreEnvironment("DEVSHELL_AGENT_TARGET", previousTarget);
        restoreEnvironment("PORTABLE_DEVSHELL_PI_WORKSPACE", previousWorkspace);
        await Promise.all([
            rm(localProject, { force: true, recursive: true }),
            rm(remoteProject, { force: true, recursive: true }),
            rm(dirname(agentDir), { force: true, recursive: true }),
        ]);
    }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const [home, workspace, reverseWorkspace] = process.argv.slice(2);
    if (home === undefined || workspace === undefined || reverseWorkspace === undefined) {
        throw new Error("usage: PiStandaloneSmoke.mjs <home> <workspace> <reverse-workspace>");
    }
    const result = await runTestspacePiStandaloneSmoke({ home, reverseWorkspace, workspace });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function resetProject(root, resourceName, context) {
    await rm(root, { force: true, recursive: true });
    await mkdir(join(root, ".pi", "prompts"), { recursive: true });
    await mkdir(join(root, ".pi", "skills"), { recursive: true });
    await writeFile(join(root, "AGENTS.md"), `${context}\n`, "utf8");
    await writeFile(join(root, ".pi", "prompts", `${resourceName}.md`), `${resourceName} prompt\n`, "utf8");
    await writeFile(
        join(root, ".pi", "skills", `${resourceName}.md`),
        `---\nname: ${resourceName}\ndescription: ${resourceName}\n---\n${resourceName} skill\n`,
        "utf8",
    );
}

async function resetGlobalResources(agentDir) {
    await rm(dirname(agentDir), { force: true, recursive: true });
    await mkdir(join(agentDir, "prompts"), { recursive: true });
    await mkdir(join(agentDir, "skills"), { recursive: true });
    await writeFile(join(agentDir, "AGENTS.md"), "GLOBAL_CONTEXT_SHOULD_REMAIN\n", "utf8");
    await writeFile(join(agentDir, "prompts", "global-only.md"), "global-only prompt\n", "utf8");
    await writeFile(
        join(agentDir, "skills", "global-only.md"),
        "---\nname: global-only\ndescription: global-only\n---\nglobal-only skill\n",
        "utf8",
    );
}

function assertRemoteCommands(session, resourceName) {
    const names = commandNames(session).filter((name) => name.includes("remote-"));
    assert.deepEqual(names, [resourceName, `skill:${resourceName}`].sort());
}

function assertNativePiResources(resourceLoader) {
    const prompts = resourceLoader.getPrompts().prompts.map((prompt) => prompt.name).sort();
    const skills = resourceLoader.getSkills().skills.map((skill) => skill.name).sort();
    assert.equal(prompts.includes("global-only"), true);
    assert.equal(skills.includes("global-only"), true);
    assert.equal(prompts.includes("local-only"), false);
    assert.equal(skills.includes("local-only"), false);
}

function assertNoCommand(session, name) {
    assert.equal(commandNames(session).includes(name), false);
}

function commandNames(session) {
    return session.extensionRunner
        .getRegisteredCommands()
        .map((command) => command.invocationName)
        .sort();
}

function restoreEnvironment(name, value) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}
