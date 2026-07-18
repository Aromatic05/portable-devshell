import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const requiredDevelopmentWorkflows = [
    { label: "Target CI", path: ".github/workflows/ci.yml" }
];

export function evaluateDevelopmentCiRuns(runs, commitSha) {
    if (typeof commitSha !== "string" || commitSha.length === 0) {
        throw new Error("commitSha must be a non-empty string.");
    }

    const matchingRuns = runs.filter((run) =>
        run?.head_sha === commitSha &&
        run?.event === "push" &&
        typeof run?.head_branch === "string" &&
        run.head_branch.startsWith("dev")
    );

    const workflows = requiredDevelopmentWorkflows.map((requirement) => {
        const candidates = matchingRuns
            .filter((run) => run.path === requirement.path)
            .sort((left, right) => String(right.created_at ?? "").localeCompare(String(left.created_at ?? "")));
        const successful = candidates.find((run) => run.status === "completed" && run.conclusion === "success");
        return {
            ...requirement,
            candidates,
            successful
        };
    });

    return {
        ok: workflows.every((workflow) => workflow.successful !== undefined),
        workflows
    };
}

export async function fetchRepositoryWorkflowRuns({ repository, token, fetchImpl = fetch }) {
    const runs = [];
    for (let page = 1; page <= 5; page += 1) {
        const response = await fetchImpl(
            `https://api.github.com/repos/${repository}/actions/runs?per_page=100&page=${page}`,
            {
                headers: {
                    Accept: "application/vnd.github+json",
                    Authorization: `Bearer ${token}`,
                    "User-Agent": "portable-devshell-release-gate",
                    "X-GitHub-Api-Version": "2022-11-28"
                }
            }
        );
        if (!response.ok) {
            throw new Error(`GitHub Actions lookup failed with HTTP ${response.status}: ${await response.text()}`);
        }
        const payload = await response.json();
        if (!Array.isArray(payload.workflow_runs)) {
            throw new Error("GitHub Actions response did not contain workflow_runs.");
        }
        runs.push(...payload.workflow_runs);
        if (payload.workflow_runs.length < 100) {
            break;
        }
    }
    return runs;
}

async function main() {
    const repository = process.env.GITHUB_REPOSITORY;
    const commitSha = process.env.GITHUB_SHA;
    const token = process.env.GITHUB_TOKEN;
    if (!repository || !commitSha || !token) {
        throw new Error("GITHUB_REPOSITORY, GITHUB_SHA, and GITHUB_TOKEN are required.");
    }

    const runs = await fetchRepositoryWorkflowRuns({ repository, token });
    const result = evaluateDevelopmentCiRuns(runs, commitSha);
    if (!result.ok) {
        for (const workflow of result.workflows) {
            const latest = workflow.candidates[0];
            if (workflow.successful !== undefined) {
                process.stderr.write(`${workflow.label}: passed via ${workflow.successful.head_branch} (${workflow.successful.html_url})\n`);
            } else if (latest !== undefined) {
                process.stderr.write(
                    `${workflow.label}: latest matching run ${latest.head_branch} is ${latest.status}/${latest.conclusion ?? "unknown"} (${latest.html_url})\n`
                );
            } else {
                process.stderr.write(`${workflow.label}: no dev-tag run found for ${commitSha}.\n`);
            }
        }
        throw new Error(`Release blocked: the commit ${commitSha} has not passed every required development CI workflow.`);
    }

    for (const workflow of result.workflows) {
        process.stdout.write(`${workflow.label}: passed via ${workflow.successful.head_branch} (${workflow.successful.html_url})\n`);
    }
}

const entrypoint = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (entrypoint === fileURLToPath(import.meta.url)) {
    await main();
}
