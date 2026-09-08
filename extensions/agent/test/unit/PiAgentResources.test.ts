import assert from "node:assert/strict";
import test from "node:test";

import {
    mergeManagedPiProjectPrompts,
    mergeManagedPiProjectSkills
} from "../../src/provider/pi/PiAgentResources.ts";

const userSource = { path: "/user", source: "local", scope: "user" as const, origin: "top-level" as const };
const projectSource = { path: "/runtime", source: "local", scope: "project" as const, origin: "top-level" as const };
const packageSource = { path: "/package", source: "package", scope: "temporary" as const, origin: "package" as const };

test("managed Pi resources replace runtime project skills with remote project skills while preserving higher-priority resources", () => {
    const current = {
        diagnostics: [],
        skills: [
            { name: "shared", sourceInfo: userSource },
            { name: "user-only", sourceInfo: userSource },
            { name: "runtime-only", sourceInfo: projectSource },
            { name: "package-only", sourceInfo: packageSource }
        ]
    };
    const remote = [
        { name: "shared", sourceInfo: projectSource },
        { name: "remote-only", sourceInfo: projectSource }
    ];

    const result = mergeManagedPiProjectSkills(current, remote);
    assert.deepEqual(result.skills.map((skill) => skill.name), ["shared", "user-only", "package-only", "remote-only"]);
    assert.deepEqual(result.remoteSkillNames, new Set(["remote-only"]));
});

test("managed Pi resources replace runtime project prompts without overriding user prompt names", () => {
    const current = {
        diagnostics: [],
        prompts: [
            { name: "release", sourceInfo: userSource },
            { name: "runtime", sourceInfo: projectSource }
        ]
    };
    const remote = [
        { name: "release", sourceInfo: projectSource },
        { name: "review", sourceInfo: projectSource }
    ];

    const result = mergeManagedPiProjectPrompts(current, remote);
    assert.deepEqual(result.prompts.map((prompt) => prompt.name), ["release", "review"]);
});
