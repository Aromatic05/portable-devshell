import { todoSummaries } from "../selectors/readModel.js";
import type { WebState } from "../state/WebStore.js";

export function Todos({ state }: { state: WebState }) {
    const todos = todoSummaries(state);
    return (
        <section>
            <h2>Todos</h2>
            <p className="hint">Read-only task state reported by each instance.</p>
            {todos.length === 0 ? <p className="empty">No active todos are available.</p> : <div className="todo-list">{todos.map((todo) => <article className="card" key={`${todo.instance}-${todo.taskId}-${todo.revision}`}><h3>{todo.title}</h3><p>{todo.instance} · revision {todo.revision}</p><strong>{todo.completed}/{todo.total} complete · {todo.status}</strong></article>)}</div>}
        </section>
    );
}
