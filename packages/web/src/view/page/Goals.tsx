import { useEffect } from "react";
import { workspaceFolderName } from "../Presentation.js";
import { useDomainSnapshot, useWebDomains } from "../../app/domain/Context.js";

export function Goals() {
    const domains = useWebDomains();
    const instances = useDomainSnapshot(domains.instances).instances;
    const goalsState = useDomainSnapshot(domains.goals);
    useEffect(() => {
        for (const instance of instances) void domains.goals.load(instance.name);
    }, [domains, instances]);
    const rows = instances.flatMap(({ name }) =>
        (goalsState.instances[name]?.goals ?? []).map((goal) => ({ goal, instance: name })),
    );
    return (
        <section>
            <h2>Goals</h2>
            <p className="hint">Final objectives for each active Workspace. Plans and checkpoints are kept in Agent Memory.</p>
            {rows.length === 0 ? <p className="empty">No active Workspace Goals.</p> : (
                <div className="goal-list">
                    {rows.map(({ goal, instance }) => (
                        <article className="card" data-goal-id={goal.goalId}
                            data-goal-status={goal.status} key={`${instance}-${goal.goalId}`}>
                            <h4>{goal.objective}</h4>
                            <p>{instance} · {workspaceFolderName(goal.workspace)} · revision {goal.revision}</p>
                            <strong>{goal.status}</strong>
                            {goal.note === undefined ? null : <p>{goal.note}</p>}
                        </article>
                    ))}
                </div>
            )}
        </section>
    );
}
