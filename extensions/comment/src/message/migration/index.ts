/** One-time import of historical 0.7.x SQLite files, before normal Host Database access.
 * Unlike MessageStore, this compatibility-only path does not own a live connection.
 * The source is retained for rollback and the imported target is never replaced.
 */
export { migrateMessageDatabase } from "./Legacy.js";
