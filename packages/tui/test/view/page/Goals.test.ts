import assert from "node:assert/strict";
import test from "node:test";
import { selectMainScreenModel, TuiAppStore } from "../../../src/testing.ts";
import { TuiTestDomains } from "../../support/DomainHarness.js";

function workspace(goals: Array<{goalId:string;objective:string;status:"active"|"blocked";revision:number;note?:string}>) {
    const domains = new TuiTestDomains();
    const store = new TuiAppStore({ domains: domains.reader });
    domains.setInstances([{ enabled: true, mcpEnabled: true, name: "alpha" }]);
    domains.setGoals("alpha", goals);
    store.setSelectedInstance("alpha");
    store.setSelectedPage("goals");
    return selectMainScreenModel(store.getState(), domains.reader);
}

test("Goals page shows a final objective without steps or Todo subitems", () => {
    const model = workspace([{goalId:"goal-1",objective:"Release beta",status:"active",revision:3,note:"See Memory"}]);
    assert.deepEqual(model.boxes.map((box) => box.id), ["goal:goal-1"]);
    assert.match(JSON.stringify(model.boxes), /Release beta/u);
    assert.equal(JSON.stringify(model.boxes).includes("todo-item"), false);
});

test("Goals page shows an empty state when no objective exists", () => {
    assert.deepEqual(workspace([]).boxes.map((box) => box.id), ["goals-empty"]);
});

test("Goals page distinguishes a failed read from an empty authoritative list", () => {
    const domains = new TuiTestDomains();
    const store = new TuiAppStore({ domains: domains.reader });
    domains.setInstances([{ enabled: true, mcpEnabled: true, name: "alpha" }]);
    domains.setGoals("alpha", []);
    domains.goals.patch({
        instances: {
            ...domains.goals.state.instances,
            alpha: {
                ...domains.goals.state.instances.alpha,
                failure: new Error("Goal authority unreachable"),
            },
        },
    });
    store.setSelectedInstance("alpha");
    store.setSelectedPage("goals");
    const model = selectMainScreenModel(store.getState(), domains.reader);
    assert.deepEqual(model.boxes.map((box) => box.id), ["goals-error"]);
    assert.match(JSON.stringify(model.boxes), /Goal authority unreachable/u);
});
