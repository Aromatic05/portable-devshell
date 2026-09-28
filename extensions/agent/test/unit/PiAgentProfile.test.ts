import assert from "node:assert/strict";
import test from "node:test";

import { parsePiAgentProfile } from "../../src/provider/pi/profile/Profile.ts";
import {
    createPiChildAgentPath,
    PI_MAIN_AGENT_PATH,
    resolvePiAgentReference,
} from "../../src/provider/pi/subagent/Namespace.ts";

test("Pi Agent Profile keeps only prompt and candidate model policy", () => {
    const profile = parsePiAgentProfile(
        [
            "---",
            "name: reviewer",
            "models:",
            "  - openai/gpt-review",
            "  - anthropic/claude-review",
            "---",
            "Review the requested change and report concrete evidence.",
        ].join("\n"),
        {
            fallbackName: "fallback",
            filePath: ".pi/agents/reviewer.md",
            source: "project",
        },
    );

    assert.deepEqual(profile, {
        candidateModels: ["openai/gpt-review", "anthropic/claude-review"],
        filePath: ".pi/agents/reviewer.md",
        name: "reviewer",
        prompt: "Review the requested change and report concrete evidence.",
        source: "project",
    });
});

test("Pi Agent namespace gives the main Agent a stable Codex-style path", () => {
    assert.equal(PI_MAIN_AGENT_PATH, "/root/main");
    assert.equal(createPiChildAgentPath("review_auth"), "/root/main/review_auth");
    assert.equal(resolvePiAgentReference("review_auth"), "/root/main/review_auth");
    assert.equal(
        resolvePiAgentReference("/root/main/review_auth"),
        "/root/main/review_auth",
    );
    assert.throws(() => createPiChildAgentPath("bad/name"), /Agent name/u);
    assert.throws(() => resolvePiAgentReference("/other/agent"), /\/root\/main/u);
});
