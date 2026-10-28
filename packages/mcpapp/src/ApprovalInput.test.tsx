import { expect, test } from "vitest";
import { actions, authorize, click, container, hold, host, render, response, serve, snapshot } from "./BetaMatrixRound5Harness.js";
import { AppView } from "./App.js";

test("authorized pending full input is fetched on demand and tail is readable before approve", async () => {
    const state = snapshot();
    state.presentation.primary!.inputAvailable = true;
    state.presentation.primary!.detail = "x".repeat(511) + "…";
    const originalInput = JSON.stringify({ command: "x".repeat(16000) + "\nTAIL-MCPAPP-BEFORE-DECISION" });
    let reads = 0;
    serve((url, init) => {
        if (url.pathname.endsWith("/snapshot")) return response(state);
        if (url.pathname.endsWith("/approval-input")) {
            reads++;
            expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer round5-private-test-token");
            expect(url.searchParams.get("ctxId")).toBe("ctx-a");
            expect(url.searchParams.get("approvalId")).toBe("approval-a");
            return response({ approvalId: "approval-a", originalInput });
        }
        return hold(init?.signal);
    });
    await render(<AppView view="interaction" />);
    await authorize();
    expect(reads).toBe(0);
    expect(container.textContent).not.toContain("TAIL-MCPAPP");
    await click("Show full input");
    const detail = container.querySelector<HTMLElement>('[aria-label="Original approval input"]')!;
    expect(detail.textContent).toBe(originalInput);
    expect(detail.style.whiteSpace).toBe("pre-wrap");
    expect(detail.style.overflowWrap).toBe("anywhere");
    expect(actions()).toHaveLength(0);
    expect(host.contexts.map((item) => JSON.stringify(item)).join("")).not.toContain("TAIL-MCPAPP");
    await click("Approve");
    expect(actions()).toHaveLength(1);
    expect(actions()[0]!.arguments.actionId).toBe("approve");
    await click("Hide full input");
    expect(container.textContent).not.toContain("TAIL-MCPAPP");
});
