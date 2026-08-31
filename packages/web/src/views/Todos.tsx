import { workspaceFolderName } from "@portable-devshell/shared/browser";
import { useState } from "react";

import { ConfirmationDialog } from "../components/ConfirmationDialog.js";
import { todoSummaries } from "../selectors/readModel.js";
import type { WebStore } from "../state/WebStore.js";
import type { WebState } from "../state/WebStore.js";

export function Todos({ disabled = false, state, store }: { disabled?: boolean; state: WebState; store: WebStore }) {
    const goals = Object.entries(state.readModel.instanceState).flatMap(([instance, value]) =>
        (value.goals ?? []).map((goal) => ({ goal, instance })),
    );
    const todos = todoSummaries(state);
    const [selected, setSelected] = useState<typeof todos[number]>();
    const interactive = state.connection === "online" && !disabled;
    return (
        <section>
            <h2>Todos</h2>
            <p className="hint">Workspace goals and read-only task state reported by each instance.</p>
            <h3>Goals</h3>
            {goals.length === 0 ? <p className="empty">No active Workspace Goals.</p> : <div className="todo-list">{goals.map(({ goal, instance }) => {
                const completed = goal.steps.filter((step) => step.status === "completed" || step.status === "skipped").length;
                return <article className="card" data-goal-id={goal.goalId} data-goal-status={goal.status} key={`${instance}-${goal.goalId}`}>
                    <h4>{goal.objective}</h4>
                    <p>{instance} · {workspaceFolderName(goal.workspace)} · revision {goal.revision}</p>
                    <strong>{completed}/{goal.steps.length} steps · {goal.status}</strong>
                </article>;
            })}</div>}
            <h3>Tasks</h3>
            {todos.length === 0 ? <p className="empty">No active todos are available.</p> : <div className="todo-list">{todos.map((todo) => <article className="card" key={`${todo.instance}-${todo.taskId}-${todo.revision}`}><h3>{todo.title}</h3><p>{todo.instance} · revision {todo.revision}</p><strong>{todo.completed}/{todo.total} complete · {todo.status}</strong><p><button disabled={!interactive} onClick={() => setSelected(todo)}>Delete project</button></p></article>)}</div>}
            {selected === undefined ? null : <ConfirmationDialog actionLabel="Delete" busy={state.operations[`todo-delete:${selected.instance}:${selected.taskId}`] !== undefined} description={`Delete ${selected.title} (${selected.taskId}) from instance ${selected.instance}? This permanently removes the project and its history.`} disabled={!interactive} onCancel={() => setSelected(undefined)} onConfirm={() => { void store.deleteTodo(selected.instance, selected.taskId).finally(() => setSelected(undefined)); }} />}
        </section>
    );
}
