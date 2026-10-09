import type { ControlHttpLease, ControlHttpServerOptions } from "./Api.js";
import { Host, Lease } from "./Host.js";

/** Control owns physical HTTP listeners; consumers receive revocable leases. */
export class ControlHttpServer {
    readonly #hosts = new Map<string, Host>();
    readonly #leases = new Set<Lease>();
    readonly #hostLeaseCount = new Map<string, number>();
    #closed = false;

    acquire(options: ControlHttpServerOptions): ControlHttpLease {
        if (this.#closed) throw new Error("Control HTTP server is closed.");
        const key = `${options.listenHost}:${options.listenPort}`;
        let host = this.#hosts.get(key);
        if (host === undefined) {
            host = new Host(key, options.listenHost, options.listenPort, options.shutdownGraceMs ?? 10_000);
            this.#hosts.set(key, host);
        }
        const lease = new Lease(host, (released) => {
            this.#leases.delete(released);
            const remaining = (this.#hostLeaseCount.get(key) ?? 1) - 1;
            if (remaining === 0) {
                this.#hostLeaseCount.delete(key);
                this.#hosts.delete(key);
            } else {
                this.#hostLeaseCount.set(key, remaining);
            }
        });
        this.#leases.add(lease);
        this.#hostLeaseCount.set(key, (this.#hostLeaseCount.get(key) ?? 0) + 1);
        return lease;
    }

    async close(): Promise<void> {
        if (this.#closed) return;
        this.#closed = true;
        const result = await Promise.allSettled([...this.#leases].map((lease) => lease.dispose()));
        this.#leases.clear();
        this.#hostLeaseCount.clear();
        this.#hosts.clear();
        const failures = result.filter((r): r is PromiseRejectedResult => r.status === "rejected");
        if (failures.length > 0)
            throw new AggregateError(
                failures.map((r) => r.reason),
                "HTTP listeners failed to close.",
            );
    }
}
