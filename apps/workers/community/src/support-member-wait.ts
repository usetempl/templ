import { PRODUCT_LIMITS } from "@templ/chat/plans";
import {
  LIST_SCAN_RECORDS,
  OPEN_INDEX_PREFIX,
  openIndexReady,
} from "./support-open-index";

type Storage = Pick<DurableObjectTransaction, "get" | "list">;
type RecordRow = { id: string; state: string; deleting?: boolean };
type Workflow = {
  state: string;
  ledgerVersion?: number;
  awaitingSince?: number | null;
  lastMemberMessageAt?: number | null;
  lastStaffReplyAt?: number | null;
};
const RECORD_PREFIX = "conversation-v1:";
const WORKFLOW_PREFIX = "support-workflow-v1:";
const THREAD = /^tc-[0-9a-f]{32}$/;
const BATCH = 128;

/** Counts the waiting view through the open index. The workflow state is
 * read in batches; no member data leaves this helper. */
export async function waitingOnMember(storage: Storage) {
  const indexed = await openIndexReady(storage);
  const rows = await storage.list<RecordRow>({
    prefix: indexed ? OPEN_INDEX_PREFIX : RECORD_PREFIX,
    limit: indexed
      ? PRODUCT_LIMITS.supportOpenRecords + 1
      : LIST_SCAN_RECORDS + 1,
  });
  const ids = indexed
    ? [...rows.keys()].map((key) => key.slice(OPEN_INDEX_PREFIX.length))
    : [...rows.values()]
        .filter((row) => row?.state === "open" && row.deleting !== true)
        .map((row) => row.id);
  const threads = ids.filter((id) => THREAD.test(id));
  let count = 0;
  for (let start = 0; start < threads.length; start += BATCH) {
    const batch = threads.slice(start, start + BATCH);
    const records = indexed
      ? await storage.get<RecordRow>(batch.map((id) => `${RECORD_PREFIX}${id}`))
      : rows;
    const workflows = await storage.get<Workflow>(
      batch.map((id) => `${WORKFLOW_PREFIX}${id}`),
    );
    for (const id of batch) {
      const record = records.get(`${RECORD_PREFIX}${id}`);
      const workflow = workflows.get(`${WORKFLOW_PREFIX}${id}`);
      const active = !workflow || ["open", "waiting"].includes(workflow.state);
      const awaiting =
        workflow?.ledgerVersion === 1
          ? Number.isSafeInteger(workflow.awaitingSince)
          : workflow?.state === "open" &&
            workflow.lastMemberMessageAt != null &&
            workflow.lastMemberMessageAt > (workflow.lastStaffReplyAt ?? 0);
      if (
        record?.state === "open" &&
        record.deleting !== true &&
        active &&
        !awaiting
      )
        count++;
    }
    if (count > PRODUCT_LIMITS.supportOpenRecords) break;
  }
  return {
    count: Math.min(count, PRODUCT_LIMITS.supportOpenRecords),
    more:
      count > PRODUCT_LIMITS.supportOpenRecords ||
      (!indexed && rows.size > LIST_SCAN_RECORDS),
  };
}
