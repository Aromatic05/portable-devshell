import { DatabaseSync } from 'node:sqlite';
import { Endpoint, Rpc, Stream, type JsonValue, type MessageStream } from '../../../shared/src/index.ts';

// A local SQLite ledger serves production RPC and stream protocols.
// The test owns its database path; no user state or credentials.
export function createRound4Peer(databasePath: string) {
const database = new DatabaseSync(databasePath);
database.exec('CREATE TABLE IF NOT EXISTS snapshots (instance TEXT, kind TEXT, value TEXT, PRIMARY KEY(instance, kind))');
const read = (instance: string, kind: string, empty: JsonValue): JsonValue => {
    const row = database.prepare('SELECT value FROM snapshots WHERE instance=? AND kind=?').get(instance, kind);
    return row === undefined ? empty : JSON.parse(row.value as string) as JsonValue;
};
const endpoint = new Endpoint({ host: 'round4-peer' });
const streams = new Map<string, Set<MessageStream>>();
const services: Array<{ close(): void }> = [];
for (const instance of ['alpha', 'beta']) {
    const tool = endpoint.bind('tool', instance);
    services.push(new Rpc(tool, { listCalls: (query) => {
        const calls = read(instance, 'calls', []) as Array<Record<string, JsonValue>>;
        const ids = (query as { callIds?: string[] } | undefined)?.callIds;
        return ids === undefined ? calls : calls.filter((call) => ids.includes(call.callId as string));
    } }));
    const task = endpoint.bind('task', instance);
    services.push(new Rpc(task, {
        getGoals: () => read(instance, 'goals', { goals: [], lastSeq: 0 }),
    }));
    for (const [kind, port] of [['tool', tool], ['task', task]] as const) {
        const service = new Stream(port);
        service.onOpen(async (stream, name, _message) => {
            if (name !== 'subscribe') throw new Error(`Unexpected stream ${name}`);
            const key = `${instance}:${kind}`;
            const subscribers = streams.get(key) ?? new Set();
            streams.set(key, subscribers); subscribers.add(stream);
            stream.onClose(() => subscribers.delete(stream));
            stream.onCancel(() => subscribers.delete(stream));
            await stream.send({ name: 'seed', payload: { events: [] } });
        });
        services.push(service);
    }
}
services.push(new Rpc(endpoint.bind('round4', '@control'), {
    put: async (message) => {
        const { instance, kind, value, event } = message as { instance: string; kind: string; value: JsonValue; event?: JsonValue };
        database.prepare('INSERT OR REPLACE INTO snapshots VALUES (?, ?, ?)').run(instance, kind, JSON.stringify(value));
        if (event !== undefined) {
            const port = kind === 'calls' ? 'tool' : 'task';
            for (const stream of streams.get(`${instance}:${port}`) ?? [])
                await stream.send({ name: 'event', payload: event });
        }
        return {};
    },
    read: (message) => { const { instance, kind } = message as { instance: string; kind: string }; return read(instance, kind, null); },
    subscribers: () => Object.fromEntries([...streams].map(([key, values]) => [key, values.size])),
}));
return { endpoint, close() {
    for (const service of services) service.close();
    endpoint.close(); database.close();
} };
}
