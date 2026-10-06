import { useEffect, useState, useSyncExternalStore } from "react";

import type { TodoItem } from "@portable-devshell/shared";

import { workspaceFolderName } from "../Presentation.js";
import { ConfirmationDialog } from "../component/Confirm.js";
import { todoSummaries, type TodoSummary } from "../ReadModel.js";
import { useDomainSnapshot, useWebDomains } from "../../app/domain/Context.js";
import type { WebStore } from "../../state/Store.js";

export function Todos({
    disabled = false,
    store,
}: {
    disabled?: boolean;
    store: WebStore;
}) {
    const domains = useWebDomains();
    const instances = useDomainSnapshot(domains.instances).instances;
    const goalsState = useDomainSnapshot(domains.goals);
    const server = useDomainSnapshot(domains.server);
    const state = useSyncExternalStore(
        store.subscribe,
        () => store.state,
        () => store.state,
    );
    const [selected, setSelected] = useState<TodoSummary>();
    const [failure, setFailure] = useState<string>();
    const interactive = server.status === "online" && !disabled;

    useEffect(() => {
        for (const instance of instances)
            void domains.goals.load(instance.name);
    }, [domains, instances]);

    const goalRows = instances.flatMap(({ name }) =>
        (goalsState.instances[name]?.goals ?? []).map((goal) => ({
            goal,
            instance: name,
        })),
    );
    return (
        <section>
            <h2>Todos</h2>
            <p className="hint">
                Workspace goals and read-only task state reported by each
                instance.
            </p>
            <h3>Goals</h3>
            {goalRows.length === 0 ? (
                <p className="empty">No active Workspace Goals.</p>
            ) : (
                <div className="todo-list">
                    {goalRows.map(({ goal, instance }) => {
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
            {instances.length === 0 ? (
                <p className="empty">No active todos are available.</p>
            ) : (
                <div className="todo-list">
                    {instances.map(({ name }) => (
                        <InstanceTodos
                            instance={name}
                            interactive={interactive}
                            key={name}
                            onDelete={(todo) => {
                                setFailure(undefined);
                                setSelected(todo);
                            }}
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
                    variant="destructive"
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
                                        store.state.error ??
                                            "Todo project could not be deleted.",
                                    );
                            });
                    }}
                />
            )}
        </section>
    );
}

function InstanceTodos({
    instance,
    interactive,
    onDelete,
}: {
    instance: string;
    interactive: boolean;
    onDelete(todo: TodoSummary): void;
}) {
    const domains = useWebDomains();
    const todo = domains.todo(instance);
    const todoState = useDomainSnapshot(todo);

    useEffect(() => {
        void todo.load();
    }, [todo, instance]);

    return (
        <>
            {todoSummaries(instance, todoState.todo).map((summary) => (
                <TodoCard
                    interactive={interactive}
                    items={
                        todoState.todo?.taskId === summary.taskId
                            ? todoState.todo.items
                            : []
                    }
                    key={`${summary.instance}-${summary.taskId}-${summary.revision}`}
                    onDelete={() => onDelete(summary)}
                    todo={summary}
                />
            ))}
        </>
    );
}

function TodoCard({
    interactive,
    items,
    onDelete,
    todo,
}: {
    interactive: boolean;
    items: readonly TodoItem[];
    onDelete(): void;
    todo: TodoSummary;
}) {
    return (
        <article className="card">
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
