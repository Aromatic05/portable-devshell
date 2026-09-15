import { workspaceFolderName } from "@portable-devshell/shared/browser";
import { useState } from "react";

import { ConfirmationDialog } from "../component/Confirm.js";
import { todoSummaries } from "../ReadModel.js";
import type { WebStore } from "../../state/Store.js";
import type { WebState } from "../../state/Store.js";

export function Todos({
    disabled = false,
    state,
    store,
}: {
    disabled?: boolean;
    state: WebState;
    store: WebStore;
}) {
    const goals = Object.entries(state.readModel.instanceState).flatMap(
        ([instance, value]) =>
            (value.goals ?? []).map((goal) => ({ goal, instance })),
    );
    const todos = todoSummaries(state);
    const [selected, setSelected] = useState<(typeof todos)[number]>();
    const [failure, setFailure] = useState<string>();
    const interactive = state.connection === "online" && !disabled;
    return (
        <section>
            <h2>Todos</h2>
            <p className="hint">
                Workspace goals and read-only task state reported by each
                instance.
            </p>
            <h3>Goals</h3>
            {goals.length === 0 ? (
                <p className="empty">No active Workspace Goals.</p>
            ) : (
                <div className="todo-list">
                    {goals.map(({ goal, instance }) => {
                        const completed = goal.steps.filter(
                            (step) =>
                                step.status === "completed" ||
                                step.status === "skipped",
                        ).length;
                        return (
                            <article
                                className="card"
                                data-goal-id={goal.goalId}
                                data-goal-status={goal.status}
                                key={`${instance}-${goal.goalId}`}
                            >
                                <h4>{goal.objective}</h4>
                                <p>
                                    {instance} ·{" "}
                                    {workspaceFolderName(goal.workspace)} ·
                                    revision {goal.revision}
                                </p>
                                <strong>
                                    {completed}/{goal.steps.length} steps ·{" "}
                                    {goal.status}
                                </strong>
                            </article>
                        );
                    })}
                </div>
            )}
            <h3>Tasks</h3>
            {todos.length === 0 ? (
                <p className="empty">No active todos are available.</p>
            ) : (
                <div className="todo-list">
                    {todos.map((todo) => (
                        <TodoCard
                            interactive={interactive}
                            key={`${todo.instance}-${todo.taskId}-${todo.revision}`}
                            onDelete={() => {
                                setFailure(undefined);
                                setSelected(todo);
                            }}
                            state={state}
                            todo={todo}
                        />
                    ))}
                </div>
            )}
            {selected === undefined ? null : (
                <ConfirmationDialog
                    actionLabel="Delete"
                    busy={
                        state.operations[
                            `todo-delete:${selected.instance}:${selected.taskId}`
                        ] !== undefined
                    }
                    description={`Delete ${selected.title} (${selected.taskId}) from instance ${selected.instance}? This permanently removes the project and its history.`}
                    disabled={!interactive}
                    error={failure}
                    onCancel={() => {
                        setFailure(undefined);
                        setSelected(undefined);
                    }}
                    onConfirm={() => {
                        setFailure(undefined);
                        void store
                            .deleteTodo(selected.instance, selected.taskId)
                            .then((succeeded) => {
                                if (succeeded) setSelected(undefined);
                                else
                                    setFailure(
                                        store.state?.error ??
                                            state.error ??
                                            "Todo project could not be deleted.",
                                    );
                            });
                    }}
                />
            )}
        </section>
    );
}

function TodoCard({
    interactive,
    onDelete,
    state,
    todo,
}: {
    interactive: boolean;
    onDelete(): void;
    state: WebState;
    todo: ReturnType<typeof todoSummaries>[number];
}) {
    const raw = state.readModel.instanceState[todo.instance]?.todo;
    const items = raw?.taskId === todo.taskId ? raw.items : [];
    return (
        <article
            className="card"
            key={`${todo.instance}-${todo.taskId}-${todo.revision}`}
        >
            <h3>{todo.title}</h3>
            <p>
                {todo.instance} · revision {todo.revision}
            </p>
            <strong>
                {todo.completed}/{todo.total} complete · {todo.status}
            </strong>
            {todo.currentItem === undefined ? null : (
                <p>
                    <strong>Current</strong>
                    {todo.currentItem}
                </p>
            )}
            {todo.checkpoint === undefined ? null : (
                <div className="todo-checkpoint">
                    <p>
                        <strong>Checkpoint</strong>
                        {todo.checkpoint.summary}
                    </p>
                    {todo.checkpoint.next === undefined ? null : (
                        <p>
                            <strong>Next</strong>
                            {todo.checkpoint.next}
                        </p>
                    )}
                    {todo.checkpoint.blockers === undefined ||
                    todo.checkpoint.blockers.length === 0 ? null : (
                        <p>
                            <strong>Blockers</strong>
                            {todo.checkpoint.blockers.join(" · ")}
                        </p>
                    )}
                </div>
            )}
            {items.length === 0 ? null : (
                <details className="todo-details">
                    <summary>Task steps</summary>
                    <ol>
                        {items.map((item) => (
                            <li key={item.id}>
                                <span className={`result ${item.status}`}>
                                    {item.status}
                                </span>{" "}
                                {item.content}
                                {item.detail === undefined ? null : (
                                    <small>{item.detail}</small>
                                )}
                            </li>
                        ))}
                    </ol>
                </details>
            )}
            <p>
                <button
                    className="danger subtle"
                    disabled={!interactive}
                    onClick={onDelete}
                >
                    Delete project
                </button>
            </p>
        </article>
    );
}
