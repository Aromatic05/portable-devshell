import { useState } from "react";

import { ConfirmationDialog } from "../components/ConfirmationDialog.js";
import { todoSummaries } from "../selectors/readModel.js";
import type { WebStore } from "../state/WebStore.js";
import type { WebState } from "../state/WebStore.js";

export function Todos({ state, store }: { state: WebState; store: WebStore }) {
    const todos = todoSummaries(state);
    const [selected, setSelected] = useState<typeof todos[number]>();
    return (
        <section>
            <h2>Todos</h2>
            <p className="hint">Read-only task state reported by each instance.</p>
            {todos.length === 0 ? <p className="empty">No active todos are available.</p> : <div className="todo-list">{todos.map((todo) => <article className="card" key={`${todo.instance}-${todo.taskId}-${todo.revision}`}><h3>{todo.title}</h3><p>{todo.instance} · revision {todo.revision}</p><strong>{todo.completed}/{todo.total} complete · {todo.status}</strong><p><button disabled={state.connection !== "online"} onClick={() => setSelected(todo)}>Delete project</button></p></article>)}</div>}
            {selected === undefined ? null : <ConfirmationDialog actionLabel="Delete" busy={state.operations[`todo-delete:${selected.instance}:${selected.taskId}`] !== undefined} description={`Delete ${selected.title}? This permanently removes the project and its history.`} onCancel={() => setSelected(undefined)} onConfirm={() => { void store.deleteTodo(selected.instance, selected.taskId).finally(() => setSelected(undefined)); }} />}
        </section>
    );
}
