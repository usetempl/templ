/** What Templ added to a case, and a month of cases, for billing managers.
 * Everything comes from the worker's contribution facts in the case ledger:
 * flags, counts and times. Nothing here reads message text, a wallet, a
 * member or a thread's content, and nothing grants access: the caller
 * already checked that the viewer manages billing. */
import type {
  ProductCaseAdded,
  ProductMonthActivity,
} from "@templ/chat/product-catalog";
import type { SupportCase } from "@templ/chat/support";
import { readCase, readCasesOpened, type CaseThreadId } from "./support-case-data";

type ReadStorage = Pick<DurableObjectStorage, "get" | "list">;

/** Cases one month read covers; `complete` says when a month held more. */
export const MONTH_ACTIVITY_CASES = 5_000;
const MONTH = /^(\d{4})(\d{2})$/;

function added(c: SupportCase): ProductCaseAdded {
  return {
    walletVerified: c.contributions?.walletVerifiedAt !== undefined,
    transactionCheck: c.contributions?.transactionCheckAt !== undefined,
    aiAnswered: c.contributions?.aiAnswerAt !== undefined,
    aiDraftUsed: (c.ai?.draftsUsed ?? 0) > 0,
    firstReplyMs:
      c.firstReplyAt === null ? null : Math.max(0, c.firstReplyAt - c.openedAt),
  };
}

/** The facts of one case, or null once its ledger row is gone. */
export async function caseAdded(
  storage: ReadStorage,
  thread: string,
  seq: number,
): Promise<ProductCaseAdded | null> {
  const read = await readCase(storage, { thread: thread as CaseThreadId, seq });
  if (!read) return null;
  return added(read.case);
}

/** [start, end) of a UTC month given as `yyyymm`, or null. */
export function monthRange(month: string): { from: number; to: number } | null {
  const match = MONTH.exec(month);
  if (!match) return null;
  const year = Number(match[1]);
  const index = Number(match[2]) - 1;
  if (index < 0 || index > 11) return null;
  return { from: Date.UTC(year, index, 1), to: Date.UTC(year, index + 1, 1) };
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** The cases opened in one UTC month. Canary cases and staff previews are
 * Templ's and the team's own and are left out; test accounts count, like
 * any case the team answered. */
export async function monthActivity(
  storage: ReadStorage,
  month: string,
): Promise<ProductMonthActivity | null> {
  const range = monthRange(month);
  if (!range) return null;
  const cases = (
    await readCasesOpened(storage, {
      ...range,
      limit: MONTH_ACTIVITY_CASES + 1,
    })
  ).filter(
    (read) =>
      !read.case.excluded.includes("canary") &&
      !read.case.excluded.includes("staff-preview") &&
      !read.case.excluded.includes("install-preview"),
  );
  const complete = cases.length <= MONTH_ACTIVITY_CASES;
  const counted = cases.slice(0, MONTH_ACTIVITY_CASES);
  const firstReplies: number[] = [];
  const resolves: number[] = [];
  const activity: ProductMonthActivity = {
    month,
    opened: counted.length,
    answered: 0,
    resolved: 0,
    notSolved: 0,
    reopened: 0,
    medianFirstReplyMs: null,
    medianResolveMs: null,
    walletVerified: 0,
    transactionChecks: 0,
    aiAnswers: 0,
    aiDraftsUsed: 0,
    complete,
  };
  for (const read of counted) {
    const c = read.case;
    const facts = added(c);
    if (c.firstReplyAt !== null) activity.answered++;
    if (c.resolvedAt !== null) {
      activity.resolved++;
      resolves.push(Math.max(0, c.resolvedAt - c.openedAt));
    }
    if (c.confirmation === "not-solved") activity.notSolved++;
    if (c.reopens > 0) activity.reopened++;
    if (facts.firstReplyMs !== null) firstReplies.push(facts.firstReplyMs);
    if (facts.walletVerified) activity.walletVerified++;
    if (facts.transactionCheck) activity.transactionChecks++;
    if (facts.aiAnswered) activity.aiAnswers = (activity.aiAnswers ?? 0) + 1;
    if (facts.aiDraftUsed) activity.aiDraftsUsed++;
  }
  activity.medianFirstReplyMs = median(firstReplies);
  activity.medianResolveMs = median(resolves);
  return activity;
}
