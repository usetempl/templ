import { standardPlanRecords } from "./product-standard-plan";
import { formatStandardAiRate } from "@templ/chat/standard-usage";
/** A billing manager's monthly statement: opening and closing balance,
 * top-ups with their chain, hash, payer and bonus, charges by price step,
 * credits with their dispute reason, and Templ's incident credits. Every
 * row is a balance change filed under the month it happened in, so the
 * opening balance plus the rows is the closing balance. Amounts and hashes
 * only; never a thread, member or message. */
import {
  productPriceSource,
  type ProductStatement,
} from "@templ/chat/product-catalog";
import { HttpError } from "./common";
import { usageStatement } from "./product-usage-billing";
import { manualStatement } from "./product-manual-billing";
import { readProductOrderForms } from "./product-order-forms";
import { productReceipts } from "./product-billing";
import { readChargeMonth } from "./product-charges";
import {
  BALANCE_MONTH_PREFIX,
  STATEMENT_PREFIX,
  type ProductStorage,
  type StatementRow,
} from "./product-entitlements";

type Storage = ProductStorage & Pick<DurableObjectTransaction, "get" | "list">;
const DAY = 86_400_000;
/** Rows read for one statement at most; the statement says when the month
 * held more. */
const STATEMENT_ROWS = 5_000;
export type { ProductStatement };
/** Until counsel reviews it, the issuer line says so. */
export const STATEMENT_ISSUER =
  "Issued by Templ. Legal entity and tax details: draft, pending counsel review.";

const monthStart = (month: string) =>
  Date.UTC(Number(month.slice(0, 4)), Number(month.slice(4, 6)) - 1, 1);
const previousMonth = (month: string) => {
  const date = new Date(monthStart(month) - DAY);
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
};

/** The closing balance of the latest month on or before `month` that has
 * one, or 0. */
async function closingOnOrBefore(storage: Storage, month: string) {
  const rows = await storage.list<{ closingCents: number }>({
    prefix: BALANCE_MONTH_PREFIX,
    end: `${BALANCE_MONTH_PREFIX}${month}~`,
    reverse: true,
    limit: 1,
  });
  const row = [...rows.values()][0];
  return Number.isSafeInteger(row?.closingCents) ? row!.closingCents : 0;
}

export async function productStatement(
  storage: Storage,
  month: string,
  now: number,
): Promise<ProductStatement> {
  const from = monthStart(month);
  const openingCents = await closingOnOrBefore(storage, previousMonth(month));
  const closingCents =
    from > now ? openingCents : await closingOnOrBefore(storage, month);
  // A verified receipt adds its payer; an operator's credit of an
  // unmatched payment has none.
  const receipts = new Map(
    (await productReceipts(storage)).map((receipt) => [
      receipt.paymentId,
      receipt,
    ]),
  );
  const listed = await storage.list<StatementRow>({
    prefix: `${STATEMENT_PREFIX}${month}:`,
    limit: STATEMENT_ROWS + 1,
  });
  const rows = [...listed].slice(0, STATEMENT_ROWS);
  const topUps: ProductStatement["topUps"] = [];
  const steps = new Map<number, { cases: number; cents: number }>();
  const charges: ProductStatement["charges"] = [];
  const pilotCredits: ProductStatement["pilotCredits"] = [];
  let forms: Awaited<ReturnType<typeof readProductOrderForms>> | undefined;
  const checkPilot = async (pilot: {
    id: string;
    title: string;
    revision: number;
  }) => {
    forms ??= await readProductOrderForms(storage);
    if (
      !forms.history.some(
        (form) =>
          form.id === pilot.id &&
          form.revision === pilot.revision &&
          form.pilot?.title === pilot.title,
      )
    )
      throw new HttpError(503, "The pilot form could not be checked.");
  };
  const credits: ProductStatement["credits"] = [];
  const incidents: ProductStatement["incidents"] = [];
  for (const [, row] of rows) {
    if (row.kind === "top-up") {
      const receipt = receipts.get(row.paymentId);
      let orderFormTitle: string | undefined;
      if (receipt?.orderFormRevision !== undefined) {
        forms ??= await readProductOrderForms(storage);
        const form = forms.history.find(
          (item) =>
            item.id === receipt.orderFormId &&
            item.revision === receipt.orderFormRevision,
        );
        if (!form)
          throw new HttpError(503, "The order form could not be checked.");
        orderFormTitle = form.pilot?.title;
      }
      const [chain, tx] = row.paymentId.split(":");
      topUps.push({
        paidAt: new Date(row.paidAt).toISOString(),
        chain,
        txHash: tx,
        payer: receipt?.payer ?? "credited by Templ",
        usdCents: row.usdCents,
        bonusCents: row.bonusCents,
        ...(receipt
          ? {
              rail: receipt.rail,
              network: receipt.network,
              token: receipt.token,
              recipient: receipt.recipient,
              logIndex: receipt.logIndex,
              instructionIndex: receipt.instructionIndex,
              creditedAt: receipt.creditedAt,
              requestId: receipt.requestId,
              orderFormId: receipt.orderFormId,
              orderFormRevision: receipt.orderFormRevision,
              ...(orderFormTitle ? { orderFormTitle } : {}),
            }
          : {}),
      });
    } else if (row.kind === "case-price") {
      const priceSource = productPriceSource(row.priceVersion);
      if (!priceSource)
        throw new HttpError(503, "The case price could not be checked.");
      if (priceSource.kind === "order-form") {
        forms ??= await readProductOrderForms(storage);
        if (
          !forms.history.some(
            (form) =>
              form.id === priceSource.id &&
              form.revision === priceSource.revision,
          )
        )
          throw new HttpError(503, "The order form could not be checked.");
      }
      if (row.pilot) await checkPilot(row.pilot);
      charges.push({
        ref: row.ref,
        priceCents: row.priceCents,
        priceSource,
        ...(row.contributions ? { contributions: row.contributions } : {}),
        ...(row.billingReason ? { billingReason: row.billingReason } : {}),
        ...(row.pilot ? { pilot: row.pilot } : {}),
        ...(row.capReason ? { capReason: row.capReason } : {}),
      });
    } else if (row.kind === "pilot-credit") {
      await checkPilot(row.pilot);
      pilotCredits.push({ ref: row.ref, cents: row.cents, pilot: row.pilot });
    } else if (row.kind === "charge") {
      const step = steps.get(row.priceCents) ?? { cases: 0, cents: 0 };
      step.cases++;
      step.cents += row.priceCents;
      steps.set(row.priceCents, step);
    } else if (row.kind === "credit")
      credits.push({ ref: row.ref, reason: row.reason, cents: row.cents });
    else
      incidents.push({ at: new Date(row.at).toISOString(), cents: row.cents });
  }
  const totals = await readChargeMonth(storage, month);
  const standard = await standardPlanRecords(storage);
  const nextMonth = new Date(from);
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  const to = nextMonth.getTime();
  const inMonth = (at: number | null) => at !== null && from <= at && at < to;
  const standardReferences = standard.references.filter((row) =>
    inMonth(row.recordedAt),
  );
  const standardCases = standard.cases.filter((row) =>
    inMonth(row.countedAt ?? row.confirmedAt),
  );
  const standardUsageReviews = (standard.usageReviews ?? []).filter((row) =>
    inMonth(row.recordedAt),
  );
  const relatedPeriods = new Set(
    [
      ...standardReferences,
      ...standardCases,
      ...standardUsageReviews,
      ...(standard.cashPayments ?? []).filter((row) => inMonth(row.recordedAt)),
    ].map((row) => row.period),
  );
  return {
    month,
    issuer: STATEMENT_ISSUER,
    ...(standard.periods.length ||
    standard.references.length ||
    standard.cases.length
      ? {
          standard: {
            periods: standard.periods.filter(
              (row) =>
                (row.startsAt < to && row.endsAt > from) ||
                relatedPeriods.has(row.id),
            ),
            references: standard.references.filter((row) =>
              inMonth(row.recordedAt),
            ),
            cashPayments: (standard.cashPayments ?? []).filter((row) =>
              inMonth(row.recordedAt),
            ),
            cases: standardCases,
            ...(standardUsageReviews.length
              ? { usageReviews: standardUsageReviews }
              : {}),
            truncated: standard.partial,
          },
        }
      : {}),
    manual: await manualStatement(storage, month),
    usage: await usageStatement(storage, month),
    openingCents,
    closingCents,
    topUps,
    steps: [...steps]
      .sort(([a], [b]) => b - a)
      .map(([priceCents, step]) => ({ priceCents, ...step })),
    charges,
    pilotCredits,
    free: totals.free,
    grant: totals.grant,
    credits,
    incidents,
    truncated: listed.size > STATEMENT_ROWS,
  };
}

const cell = (value: string | number) => {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
const literalText = (text: string) =>
  /^[\s\u0000-\u001f\u007f]*[=+\-@]/.test(text) ? `'${text}` : text;
const dollars = (cents: number) => (cents / 100).toFixed(2);
const nanoDollars = (value: string) => {
  const nanos = BigInt(value);
  return `${nanos / 1_000_000_000n}.${String(nanos % 1_000_000_000n).padStart(9, "0")}`;
};

/** The statement as CSV rows: one section per kind, amounts in dollars.
 * Standard usage rows show cumulative reviewed charges, never payments.
 * The `listing` row says whether the file holds every row of the month. */
export function statementCsv(statement: ProductStatement) {
  const rows: (string | number)[][] = [
    [
      "section",
      "date",
      "detail",
      "reference",
      "count",
      "amount_usd",
      "rail",
      "network",
      "token",
      "payer",
      "recipient",
      "log_index",
      "instruction_index",
      "credited_at",
      "request_id",
      "order_form_id",
      "order_form_title",
      "order_form_revision",
      "reason",
      "case_charge_usd",
      "upfront_credit_usd",
      "billing_reason",
      "transaction_check_at",
      "wallet_verified_at",
      "ai_answer_at",
    ],
    ["opening", statement.month, "", "", "", dollars(statement.openingCents)],
    ...(statement.usage
      ? [
          [
            "usage-opening",
            statement.month,
            "",
            "",
            "",
            dollars(statement.usage.openingCents),
          ],
          [
            "usage-listing",
            statement.month,
            statement.usage.truncated ? "partial" : "complete",
            "",
            "",
            "",
          ],
          ...statement.usage.rows.map((row) => [
            `usage-${row.kind}`,
            new Date(row.at).toISOString(),
            row.feature ?? row.reason ?? "",
            row.ref ?? row.paymentId ?? row.referenceSha256 ?? row.id,
            "",
            dollars(row.cents),
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            row.formId ?? "",
            "",
            row.formRevision ?? "",
          ]),
          [
            "usage-closing",
            statement.month,
            "",
            "",
            "",
            dollars(statement.usage.closingCents),
          ],
        ]
      : []),
    ...(statement.standard
      ? [
          [
            "standard-listing",
            statement.month,
            statement.standard.truncated ? "partial" : "complete",
            "",
            "",
            "",
          ],
          ...statement.standard.periods.flatMap((row) =>
            row.usage
              ? [
                  [
                    "standard-period",
                    new Date(row.startsAt).toISOString(),
                    `${row.source}; ends ${new Date(row.endsAt).toISOString()}; price ${row.usage.priceVersion}; includes ${row.usage.includedAnsweredCases} answered cases; additional ${dollars(row.usage.additionalAnsweredCaseCents)}; retail AI credit ${dollars(row.usage.includedAiCreditCents)}; AI multiplier ${formatStandardAiRate(row.usage)}; rate card ${row.usage.aiRateCardVersion}`,
                    row.id,
                    row.usage.aiReviewedThrough === null
                      ? ""
                      : row.usage.answeredCases,
                    "",
                  ],
                  [
                    "standard-answered-cases",
                    row.usage.aiReviewedThrough === null
                      ? ""
                      : new Date(row.usage.aiReviewedThrough).toISOString(),
                    `${row.usage.aiReviewedThrough === null ? "unreviewed totals unavailable" : "cumulative reviewed answered-case charge"}; not a payment`,
                    row.id,
                    row.usage.aiReviewedThrough === null
                      ? ""
                      : row.usage.answeredCases,
                    row.usage.aiReviewedThrough === null
                      ? ""
                      : dollars(row.usage.answeredCaseChargedCents),
                  ],
                  [
                    "standard-ai-usage",
                    row.usage.aiReviewedThrough === null
                      ? ""
                      : new Date(row.usage.aiReviewedThrough).toISOString(),
                    `cumulative retail usage ${row.usage.aiReviewedThrough === null ? "unavailable" : nanoDollars(row.usage.aiUsageUsdNanos) + " USD"}; credit ${dollars(row.usage.includedAiCreditCents)}; missing usage ${row.usage.aiUsageMissing}; ${row.usage.aiReviewedThrough === null ? "unreviewed" : "reviewed"}; charge is not a payment`,
                    row.id,
                    "",
                    row.usage.aiReviewedThrough === null
                      ? ""
                      : dollars(row.usage.aiUsageChargedCents),
                  ],
                ]
              : [
                  [
                    "standard-period",
                    new Date(row.startsAt).toISOString(),
                    `${row.source}; ends ${new Date(row.endsAt).toISOString()}; includes ${row.includedAiResolutions}; additional ${dollars(row.additionalAiResolutionCents)}`,
                    row.id,
                    row.confirmedAiResolutions,
                    "",
                  ],
                ],
          ),
          ...statement.standard.periods
            .filter((row) => row.monthlyDebt)
            .map((row) => [
              "standard-monthly-debt",
              new Date(row.startsAt).toISOString(),
              `period ${row.id}; founder-approved receivable; paid ${dollars(row.monthlyDebt!.paidCents)}; not a payment receipt`,
              row.referenceSha256,
              "",
              dollars(row.monthlyDebt!.chargedCents),
            ]),
          ...(statement.standard.usageReviews ?? []).map((row) => [
            "standard-usage-review",
            new Date(row.recordedAt).toISOString(),
            `period ${row.period}; cumulative through ${new Date(row.reviewedThrough).toISOString()}; provider AI ${nanoDollars(row.providerAiUsageUsdNanos)} USD; retail AI ${nanoDollars(row.aiUsageUsdNanos)} USD; answered-case charge ${dollars(row.answeredCaseChargedCents)}; AI charge ${dollars(row.aiUsageChargedCents)}; not a payment`,
            row.referenceSha256,
            row.answeredCases,
            dollars(row.chargedCents),
          ]),
          ...statement.standard.references.map((row) => [
            `standard-${row.kind}`,
            new Date(row.recordedAt).toISOString(),
            `period ${row.period}`,
            row.referenceSha256,
            "",
            dollars(row.cents),
          ]),
          ...(statement.standard.cashPayments ?? []).map((row) => [
            "standard-credit-applied",
            new Date(row.recordedAt).toISOString(),
            `period ${row.period}; paid from prepaid cash; no new cash received`,
            row.referenceId,
            "",
            dollars(row.cents),
          ]),
          ...statement.standard.cases.map((row) => [
            `standard-ai-${row.status}`,
            new Date(row.countedAt ?? row.confirmedAt!).toISOString(),
            `period ${row.period}`,
            row.ref,
            row.status === "counted" ? 1 : 0,
            dollars(row.chargedCents),
          ]),
        ]
      : []),
    [
      "listing",
      statement.month,
      statement.truncated
        ? "partial: the month has more rows than this file"
        : "complete",
      "",
      "",
      "",
    ],
    ...(statement.manual
      ? [
          [
            "manual-opening",
            statement.month,
            "amount due",
            "",
            "",
            dollars(statement.manual.openingCents),
          ],
          ...statement.manual.rows.map((row) => [
            `manual-${row.kind}`,
            new Date(row.at).toISOString(),
            `order form ${row.agreement.id} revision ${row.agreement.effectiveRevision}`,
            row.ref,
            "",
            dollars(row.kind === "charge" ? row.cents : -row.cents),
          ]),
          [
            "manual-closing",
            statement.month,
            "amount due",
            "",
            "",
            dollars(statement.manual.closingCents),
          ],
          [
            "manual-listing",
            statement.month,
            statement.manual.truncated ? "partial" : "complete",
            "",
            "",
            "",
          ],
        ]
      : []),
    ...statement.topUps.flatMap((topUp) => [
      [
        "top-up",
        topUp.paidAt,
        `${topUp.chain} from ${topUp.payer}`,
        topUp.txHash,
        "",
        dollars(topUp.usdCents),
        topUp.rail ?? "",
        topUp.network ?? topUp.chain,
        topUp.token ?? "",
        topUp.payer,
        topUp.recipient ?? "",
        topUp.logIndex ?? "",
        topUp.instructionIndex ?? "",
        topUp.creditedAt ?? "",
        topUp.requestId ?? "",
        topUp.orderFormId ?? "",
        literalText(topUp.orderFormTitle ?? ""),
        topUp.orderFormRevision ?? "",
        "",
        "",
        "",
      ],
      ...(topUp.bonusCents
        ? [
            [
              "bonus",
              topUp.paidAt,
              "bonus credit",
              topUp.txHash,
              "",
              dollars(topUp.bonusCents),
            ],
          ]
        : []),
    ]),
    ...statement.steps.map((step) => [
      "charges",
      statement.month,
      `resolved cases at ${dollars(step.priceCents)}`,
      "",
      step.cases,
      dollars(-step.cents),
    ]),
    ...statement.charges.map((charge) => [
      "case-price",
      statement.month,
      charge.pilot
        ? `${literalText(charge.pilot.title)}${charge.capReason ? ` (${charge.capReason})` : ""}, order form ${charge.pilot.id} revision ${charge.pilot.revision}`
        : charge.priceSource.kind === "order-form"
          ? `order form ${charge.priceSource.id} revision ${charge.priceSource.revision}`
          : `public prices ${charge.priceSource.version}`,
      charge.ref,
      1,
      charge.priceCents === 0 ? "0.00" : "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      charge.pilot?.id ??
        (charge.priceSource.kind === "order-form" ? charge.priceSource.id : ""),
      literalText(charge.pilot?.title ?? ""),
      charge.pilot?.revision ??
        (charge.priceSource.kind === "order-form"
          ? charge.priceSource.revision
          : ""),
      charge.capReason ?? "",
      charge.pilot ? dollars(charge.priceCents) : "",
      "",
      charge.billingReason ??
        [
          ...(charge.contributions?.transactionCheckAt !== undefined
            ? ["transaction check"]
            : []),
          ...(charge.contributions?.walletVerifiedAt !== undefined
            ? ["wallet verified"]
            : []),
          ...(charge.contributions?.aiAnswerAt !== undefined
            ? ["AI answer"]
            : []),
        ].join(", "),
      charge.contributions?.transactionCheckAt === undefined
        ? ""
        : new Date(charge.contributions.transactionCheckAt).toISOString(),
      charge.contributions?.walletVerifiedAt === undefined
        ? ""
        : new Date(charge.contributions.walletVerifiedAt).toISOString(),
      charge.contributions?.aiAnswerAt === undefined
        ? ""
        : new Date(charge.contributions.aiAnswerAt).toISOString(),
    ]),
    ...statement.pilotCredits.map((credit) => [
      "pilot-credit",
      statement.month,
      "upfront credit applied",
      credit.ref,
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      credit.pilot.id,
      literalText(credit.pilot.title),
      credit.pilot.revision,
      "",
      "",
      dollars(credit.cents),
    ]),
    [
      "free",
      statement.month,
      "free resolved cases",
      "",
      statement.free,
      "0.00",
    ],
    [
      "grant",
      statement.month,
      "resolved cases from credit",
      "",
      statement.grant,
      "0.00",
    ],
    ...statement.credits.map((credit) => [
      "credit",
      statement.month,
      `dispute: ${credit.reason}`,
      credit.ref,
      "",
      dollars(credit.cents),
    ]),
    ...statement.incidents.map((incident) => [
      "incident",
      incident.at,
      "credit from Templ",
      "",
      "",
      dollars(incident.cents),
    ]),
    ["closing", statement.month, "", "", "", dollars(statement.closingCents)],
    ["issuer", "", statement.issuer, "", "", ""],
  ];
  const width = rows[0].length;
  return `${rows
    .map((row) =>
      [...row, ...Array<string>(width - row.length).fill("")]
        .map(cell)
        .join(","),
    )
    .join("\n")}\n`;
}
