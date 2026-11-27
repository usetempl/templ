import { DatabaseSync } from "node:sqlite";
import type { KnowledgeDb, KnowledgeSqlValue } from "../src/support-knowledge-schema";

/** A SupportKnowledge database over node:sqlite for unit tests: the same
 * `exec(query, ...bindings)` and transaction shape the Durable Object's SQL
 * API gives the store. Statements with more than 100 bindings are refused,
 * as the Durable Object refuses them. */
export function knowledgeTestDb(): KnowledgeDb & { raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  let depth = 0;
  return {
    raw,
    sql: {
      exec(query: string, ...bindings: KnowledgeSqlValue[]) {
        if (bindings.length > 100) throw new Error("too many SQL bindings");
        const statement = raw.prepare(query);
        const reader = /^\s*(select|with|pragma)\b/i.test(query) || /\breturning\b/i.test(query);
        const rows = reader
          ? (statement.all(...bindings) as Record<string, unknown>[])
          : (statement.run(...bindings), []);
        return { toArray: () => rows.map((row) => ({ ...row })) };
      },
    },
    transaction<T>(fn: () => T): T {
      if (depth > 0) return fn();
      depth++;
      raw.exec("BEGIN");
      try {
        const result = fn();
        raw.exec("COMMIT");
        return result;
      } catch (error) {
        raw.exec("ROLLBACK");
        throw error;
      } finally {
        depth--;
      }
    },
  };
}
