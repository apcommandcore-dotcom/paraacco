// 信用卡分頁(2026-11-28,SPEC_cards-page_20261128.md)——人類使用者端(Cloudflare Access)。
// 卡片 = recurring_series(category='statement');銀行帳戶(card_kind='bank')不追蹤,不在這裡出現。
// paraacco 只記支出:帳單應繳金額只是參考,「已繳」手動標記,不讀銀行流水、不連帳戶餘額。
//
//   GET    /api/cards?month=YYYY-MM                卡片清單 + 近 12 個月帳單格 + 分期(含進度)+ 已隱藏的銀行帳戶
//   POST   /api/cards                              新增卡片
//   POST   /api/cards/:id                          編輯卡片(含停用:endMonth;重新啟用:endMonth=null)
//   POST   /api/cards/:id/kind                     { cardKind: 'credit_card' | 'bank' } 標成銀行帳戶 = 隱藏
//   DELETE /api/cards/:id                          只有完全沒連資料(帳單/期次/標記/分期)的卡能真刪
//   POST   /api/cards/:id/months/:month            { amountCents?, dueDate?, paid?, note? } 這個月的應繳/已繳
//   GET    /api/cards/installments?documentId=     某張發票設過的分期(文件抽屜用)
//   POST   /api/cards/installments                 新增分期
//   POST   /api/cards/installments/:id             編輯 / { status:'cancelled' } 提前清償
//   DELETE /api/cards/installments/:id             刪除(輸入錯誤用)

import { Hono } from "hono";
import { and, eq, inArray, like, or } from "drizzle-orm";
import {
  activityLog,
  cardStatementMonths,
  createDb,
  documentExtractedFields,
  documents,
  installmentPlans,
  recurringMatchReviews,
  recurringMonthMarks,
  recurringPeriods,
  recurringSeries,
  vendors,
} from "@paraacco/db";
import {
  BILLING_MONTH_FIELD_KEY,
  CARD_CATEGORY,
  CARD_KINDS,
  RECURRING_SERIES_FIELD_KEY,
  addMonths,
  currentMonthTaipeiOf,
  installmentProgress,
  isBillingMonthFieldKey,
  isCreditCardSeries,
  isValidMonth,
} from "@paraacco/domain";
import type { Bindings } from "../bindings";
import { canAccessOwnership, canWrite } from "../middleware/auth";
import { nextSeriesId, parseSeriesBody, visibleSeries, type SeriesBody } from "./recurring";

export const cardsRoute = new Hono<{ Bindings: Bindings }>();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const OWNERSHIPS = ["per", "corp", "advance", "custody", "pending"];
const EXCLUDED_DOC_STATUSES = new Set(["ignored", "dup"]);
type SeriesRow = typeof recurringSeries.$inferSelect;
type Db = ReturnType<typeof createDb>;

interface CardBody extends SeriesBody {
  statementDay?: unknown;
  debitAccount?: unknown;
}

function actorName(auth: { name: string | null; email: string | null }) {
  return auth.name ?? auth.email ?? "系統";
}

/** 卡片專屬欄位(結帳日、扣款帳戶)。 */
function parseCardExtras(body: CardBody): { patch: Partial<typeof recurringSeries.$inferInsert> } | { field: string } {
  const patch: Partial<typeof recurringSeries.$inferInsert> = {};
  if (body.statementDay !== undefined) {
    const v = body.statementDay;
    if (v !== null && (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 31)) return { field: "statementDay" };
    patch.statementDay = v as number | null;
  }
  if (body.debitAccount !== undefined) {
    patch.debitAccount = typeof body.debitAccount === "string" && body.debitAccount.trim() ? body.debitAccount.trim().slice(0, 100) : null;
  }
  return { patch };
}

/** 末四碼 → match_rule.accountRefs(帳單自動掛卡用);已有 match_rule 的保留其他鍵。 */
function withAccountRefRule(current: string | null | undefined, last4: string | null | undefined): string | null | undefined {
  if (last4 === undefined) return undefined;
  let rule: Record<string, unknown> = {};
  try {
    rule = current ? (JSON.parse(current) as Record<string, unknown>) : {};
  } catch {
    rule = {};
  }
  if (last4) rule.accountRefs = [last4];
  else delete rule.accountRefs;
  return Object.keys(rule).length ? JSON.stringify(rule) : null;
}

async function loadCard(db: Db, id: string): Promise<SeriesRow | null> {
  const [s] = await db.select().from(recurringSeries).where(eq(recurringSeries.id, id)).limit(1);
  return s && s.category === CARD_CATEGORY ? s : null;
}

// ---------------------------------------------------------------------------
// 清單
// ---------------------------------------------------------------------------
cardsRoute.get("/", async (c) => {
  const month = c.req.query("month") ?? currentMonthTaipeiOf();
  if (!isValidMonth(month)) return c.json({ error: "invalid_month" }, 400);
  const from = addMonths(month, -11);
  const db = createDb(c.env.DB);
  const scope = c.get("auth").scope;

  const allStatement = visibleSeries(
    scope,
    await db.select().from(recurringSeries).where(eq(recurringSeries.category, CARD_CATEGORY)).orderBy(recurringSeries.id),
  );
  const cards = allStatement.filter(isCreditCardSeries);
  const hiddenBanks = allStatement.filter((s) => !isCreditCardSeries(s));
  const ids = cards.map((s) => s.id);
  if (!ids.length) return c.json({ month, from, cards: [], hiddenBanks: hiddenBanks.map((s) => ({ id: s.id, name: s.name })), installments: [] });

  const [vendorRows, fieldRows, markRows, monthRows, planRows] = await Promise.all([
    db.select({ id: vendors.id, name: vendors.name }).from(vendors),
    db
      .select({
        documentId: documentExtractedFields.documentId,
        fieldKey: documentExtractedFields.fieldKey,
        value: documentExtractedFields.value,
        docStatus: documents.status,
        amountCents: documents.amountCents,
      })
      .from(documentExtractedFields)
      .innerJoin(documents, eq(documents.id, documentExtractedFields.documentId))
      .where(or(eq(documentExtractedFields.fieldKey, RECURRING_SERIES_FIELD_KEY), like(documentExtractedFields.fieldKey, `${BILLING_MONTH_FIELD_KEY}%`))),
    db.select().from(recurringMonthMarks).where(inArray(recurringMonthMarks.seriesId, ids)),
    db.select().from(cardStatementMonths).where(inArray(cardStatementMonths.seriesId, ids)),
    db.select().from(installmentPlans).where(inArray(installmentPlans.seriesId, ids)),
  ]);
  const vendorName = new Map(vendorRows.map((v) => [v.id, v.name]));

  // 帳單文件:recurring_series_id 指到這張卡、billing_month 落在區間內
  const seriesOf = new Map<string, string>();
  const monthsOf = new Map<string, string[]>();
  const amountOf = new Map<string, number | null>();
  for (const f of fieldRows) {
    if (EXCLUDED_DOC_STATUSES.has(f.docStatus) || !f.value) continue;
    amountOf.set(f.documentId, f.amountCents);
    if (f.fieldKey === RECURRING_SERIES_FIELD_KEY) seriesOf.set(f.documentId, f.value);
    else if (isBillingMonthFieldKey(f.fieldKey) && isValidMonth(f.value)) monthsOf.set(f.documentId, [...(monthsOf.get(f.documentId) ?? []), f.value]);
  }
  const docsByCardMonth = new Map<string, string[]>();
  for (const [docId, sid] of seriesOf) {
    if (!ids.includes(sid)) continue;
    for (const m of monthsOf.get(docId) ?? []) docsByCardMonth.set(`${sid}@${m}`, [...(docsByCardMonth.get(`${sid}@${m}`) ?? []), docId]);
  }

  const months: string[] = [];
  for (let m = from; m <= month; m = addMonths(m, 1)) months.push(m);

  const plans = planRows
    .filter((p) => canAccessOwnership(scope, p.ownership && p.ownership !== "pending" ? p.ownership : "corp"))
    .map((p) => ({ ...p, progress: installmentProgress(p, month) }));

  return c.json({
    month,
    from,
    cards: cards.map((s) => {
      const active = !s.endMonth || s.endMonth >= month;
      return {
        ...s,
        vendorName: s.vendorId ? (vendorName.get(s.vendorId) ?? null) : null,
        active,
        months: months.map((m) => {
          const inRange = m >= s.startMonth && (!s.endMonth || m <= s.endMonth);
          const docIds = docsByCardMonth.get(`${s.id}@${m}`) ?? [];
          const rec = monthRows.find((r) => r.seriesId === s.id && r.month === m) ?? null;
          const mark = markRows.find((r) => r.seriesId === s.id && r.month === m) ?? null;
          const docAmount = docIds.map((d) => amountOf.get(d)).find((a) => a != null) ?? null;
          return {
            month: m,
            inRange,
            documentIds: docIds,
            mark: mark?.status ?? null, // 'not_required'(當月無消費)| 'encrypted'
            amountCents: rec?.amountCents ?? docAmount,
            amountSource: rec?.amountCents != null ? "manual" : docAmount != null ? "document" : null,
            dueDate: rec?.dueDate ?? null,
            paidAt: rec?.paidAt ?? null,
            note: rec?.note ?? null,
          };
        }),
      };
    }),
    hiddenBanks: hiddenBanks.map((s) => ({ id: s.id, name: s.name })),
    installments: plans,
  });
});

// ---------------------------------------------------------------------------
// 分期付款
// ---------------------------------------------------------------------------
interface PlanBody {
  seriesId?: unknown;
  merchant?: unknown;
  totalCents?: unknown;
  periodCount?: unknown;
  perPeriodCents?: unknown;
  firstMonth?: unknown;
  ownership?: unknown;
  documentId?: unknown;
  note?: unknown;
  status?: unknown;
}

async function parsePlanBody(
  db: Db,
  scope: string | null,
  body: PlanBody,
  current?: typeof installmentPlans.$inferSelect,
): Promise<{ patch: Partial<typeof installmentPlans.$inferInsert> } | { field: string }> {
  const partial = !!current;
  const has = (k: keyof PlanBody) => body[k] !== undefined;
  const patch: Partial<typeof installmentPlans.$inferInsert> = {};
  const isPosInt = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v > 0;

  if (!partial || has("seriesId")) {
    if (typeof body.seriesId !== "string") return { field: "seriesId" };
    const card = await loadCard(db, body.seriesId);
    if (!card || !visibleSeries(scope, [card]).length) return { field: "seriesId" };
    patch.seriesId = card.id;
    if (!partial && !has("ownership")) patch.ownership = card.ownership;
  }
  if (!partial || has("merchant")) {
    if (typeof body.merchant !== "string" || !body.merchant.trim()) return { field: "merchant" };
    patch.merchant = body.merchant.trim().slice(0, 100);
  }
  if (!partial || has("totalCents")) {
    if (!isPosInt(body.totalCents)) return { field: "totalCents" };
    patch.totalCents = body.totalCents as number;
  }
  if (!partial || has("periodCount")) {
    if (!isPosInt(body.periodCount) || (body.periodCount as number) > 120) return { field: "periodCount" };
    patch.periodCount = body.periodCount as number;
  }
  if (!partial || has("perPeriodCents")) {
    if (!isPosInt(body.perPeriodCents)) return { field: "perPeriodCents" };
    patch.perPeriodCents = body.perPeriodCents as number;
  }
  if (!partial || has("firstMonth")) {
    if (!isValidMonth(body.firstMonth)) return { field: "firstMonth" };
    patch.firstMonth = body.firstMonth;
  }
  // 每期 × (期數−1) 不能超過原始金額(最後一期吸收尾差,至少 0)
  const total = patch.totalCents ?? current?.totalCents ?? 0;
  const count = patch.periodCount ?? current?.periodCount ?? 1;
  const per = patch.perPeriodCents ?? current?.perPeriodCents ?? 0;
  if (per * (count - 1) > total || per > total) return { field: "perPeriodCents" };
  if (has("ownership")) {
    if (body.ownership !== null && body.ownership !== "" && !OWNERSHIPS.includes(body.ownership as string)) return { field: "ownership" };
    patch.ownership = typeof body.ownership === "string" && body.ownership ? body.ownership : null;
  }
  const own = patch.ownership !== undefined ? patch.ownership : current?.ownership;
  if (!canAccessOwnership(scope, own && own !== "pending" ? own : "corp")) return { field: "ownership" };
  if (has("documentId")) {
    const v = typeof body.documentId === "string" && body.documentId.trim() ? body.documentId.trim() : null;
    if (v) {
      const [d] = await db.select({ id: documents.id }).from(documents).where(eq(documents.id, v)).limit(1);
      if (!d) return { field: "documentId" };
    }
    patch.documentId = v;
  }
  if (has("status")) {
    if (body.status !== "active" && body.status !== "cancelled") return { field: "status" };
    patch.status = body.status;
  }
  if (has("note")) patch.note = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 300) : null;
  return { patch };
}

async function loadPlan(db: Db, scope: string | null, id: number) {
  const [p] = await db.select().from(installmentPlans).where(eq(installmentPlans.id, id)).limit(1);
  if (!p) return null;
  if (!canAccessOwnership(scope, p.ownership && p.ownership !== "pending" ? p.ownership : "corp")) return null;
  return p;
}

cardsRoute.get("/installments", async (c) => {
  const documentId = c.req.query("documentId");
  const db = createDb(c.env.DB);
  const scope = c.get("auth").scope;
  const rows = await db
    .select()
    .from(installmentPlans)
    .where(documentId ? eq(installmentPlans.documentId, documentId) : undefined);
  const month = currentMonthTaipeiOf();
  return c.json({
    installments: rows
      .filter((p) => canAccessOwnership(scope, p.ownership && p.ownership !== "pending" ? p.ownership : "corp"))
      .map((p) => ({ ...p, progress: installmentProgress(p, month) })),
  });
});

cardsRoute.post("/installments", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);
  const body = await c.req.json<PlanBody>().catch(() => null);
  if (!body) return c.json({ error: "invalid_json" }, 400);
  const db = createDb(c.env.DB);
  const parsed = await parsePlanBody(db, auth.scope, body);
  if ("field" in parsed) return c.json({ error: "invalid_field", field: parsed.field }, 400);
  const [row] = await db
    .insert(installmentPlans)
    .values({ ...(parsed.patch as typeof installmentPlans.$inferInsert), createdByMemberId: auth.memberId })
    .returning({ id: installmentPlans.id });
  await db.insert(activityLog).values({
    entityType: "installment_plan",
    entityId: String(row.id),
    kind: "import",
    text: `${actorName(auth)} 新增分期:${parsed.patch.merchant} ${parsed.patch.periodCount} 期(${parsed.patch.seriesId}${parsed.patch.documentId ? `,${parsed.patch.documentId}` : ""})`,
    actorMemberId: auth.memberId,
  });
  return c.json({ ok: true, id: row.id }, 201);
});

cardsRoute.post("/installments/:id", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);
  const body = await c.req.json<PlanBody>().catch(() => null);
  if (!body) return c.json({ error: "invalid_json" }, 400);
  const db = createDb(c.env.DB);
  const current = await loadPlan(db, auth.scope, Number(c.req.param("id")));
  if (!current) return c.json({ error: "not_found" }, 404);
  const parsed = await parsePlanBody(db, auth.scope, body, current);
  if ("field" in parsed) return c.json({ error: "invalid_field", field: parsed.field }, 400);
  if (!Object.keys(parsed.patch).length) return c.json({ ok: true, unchanged: true });
  await db.update(installmentPlans).set({ ...parsed.patch, updatedAt: new Date().toISOString() }).where(eq(installmentPlans.id, current.id));
  if (parsed.patch.status && parsed.patch.status !== current.status) {
    await db.insert(activityLog).values({
      entityType: "installment_plan",
      entityId: String(current.id),
      kind: "review",
      text: `${actorName(auth)} ${parsed.patch.status === "cancelled" ? "結束" : "恢復"}分期:${current.merchant}`,
      actorMemberId: auth.memberId,
    });
  }
  return c.json({ ok: true });
});

cardsRoute.delete("/installments/:id", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);
  const db = createDb(c.env.DB);
  const current = await loadPlan(db, auth.scope, Number(c.req.param("id")));
  if (!current) return c.json({ error: "not_found" }, 404);
  await db.batch([
    db.delete(installmentPlans).where(eq(installmentPlans.id, current.id)),
    db.insert(activityLog).values({
      entityType: "installment_plan",
      entityId: String(current.id),
      kind: "review",
      text: `${actorName(auth)} 刪除分期:${current.merchant} ${current.periodCount} 期(${current.seriesId})`,
      actorMemberId: auth.memberId,
    }),
  ]);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// 卡片新增 / 編輯 / 隱藏 / 刪除
// ---------------------------------------------------------------------------
cardsRoute.post("/", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);
  const body = await c.req.json<CardBody>().catch(() => null);
  if (!body) return c.json({ error: "invalid_json" }, 400);
  const db = createDb(c.env.DB);
  const base = await parseSeriesBody(
    db,
    { ...body, category: CARD_CATEGORY, cadence: "monthly", needsDocument: true, paymentMethod: body.paymentMethod ?? "auto_debit" },
    false,
  );
  if ("field" in base) return c.json({ error: "invalid_field", field: base.field }, 400);
  const extras = parseCardExtras(body);
  if ("field" in extras) return c.json({ error: "invalid_field", field: extras.field }, 400);
  const matchRule = withAccountRefRule(null, base.patch.accountRef ?? null);
  const id = await nextSeriesId(db);
  await db.batch([
    db.insert(recurringSeries).values({ ...(base.patch as typeof recurringSeries.$inferInsert), ...extras.patch, matchRule: matchRule ?? null, cardKind: "credit_card", id }),
    db.insert(activityLog).values({
      entityType: "recurring_series",
      entityId: id,
      kind: "import",
      text: `${actorName(auth)} 新增信用卡:${base.patch.name}`,
      actorMemberId: auth.memberId,
    }),
  ]);
  // 不建期次、不回溯掛期:卡片的帳單格由 billing_month 文件 + card_statement_months 即時算,不產生「逾期未繳」。
  return c.json({ ok: true, id }, 201);
});

cardsRoute.post("/:id", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);
  const id = c.req.param("id");
  const body = await c.req.json<CardBody>().catch(() => null);
  if (!body) return c.json({ error: "invalid_json" }, 400);
  const db = createDb(c.env.DB);
  const current = await loadCard(db, id);
  if (!current) return c.json({ error: "not_found" }, 404);
  if (!visibleSeries(auth.scope, [current]).length) return c.json({ error: "forbidden" }, 403);
  // 卡片固定 category=statement、cadence=monthly
  const { category: _c, cadence: _d, ...rest } = body;
  const base = await parseSeriesBody(db, rest, true, current);
  if ("field" in base) return c.json({ error: "invalid_field", field: base.field }, 400);
  const extras = parseCardExtras(body);
  if ("field" in extras) return c.json({ error: "invalid_field", field: extras.field }, 400);
  const patch: Partial<typeof recurringSeries.$inferInsert> = { ...base.patch, ...extras.patch };
  const rule = withAccountRefRule(current.matchRule, base.patch.accountRef);
  if (rule !== undefined) patch.matchRule = rule;
  if (!Object.keys(patch).length) return c.json({ ok: true, unchanged: true });
  const deactivated = patch.endMonth !== undefined && patch.endMonth !== current.endMonth;
  await db.batch([
    db.update(recurringSeries).set({ ...patch, updatedAt: new Date().toISOString() }).where(eq(recurringSeries.id, id)),
    ...(deactivated
      ? [
          db.insert(activityLog).values({
            entityType: "recurring_series",
            entityId: id,
            kind: "review",
            text: patch.endMonth ? `${actorName(auth)} 停用信用卡 ${current.name}(最後帳單月份 ${patch.endMonth})` : `${actorName(auth)} 重新啟用信用卡 ${current.name}`,
            actorMemberId: auth.memberId,
          }),
        ]
      : []),
  ]);
  return c.json({ ok: true });
});

cardsRoute.post("/:id/kind", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);
  const id = c.req.param("id");
  const body = await c.req.json<{ cardKind?: string }>().catch(() => null);
  if (!body || !(CARD_KINDS as readonly unknown[]).includes(body.cardKind)) return c.json({ error: "invalid_field", field: "cardKind" }, 400);
  const db = createDb(c.env.DB);
  const current = await loadCard(db, id);
  if (!current) return c.json({ error: "not_found" }, 404);
  if (!visibleSeries(auth.scope, [current]).length) return c.json({ error: "forbidden" }, 403);
  await db.batch([
    db.update(recurringSeries).set({ cardKind: body.cardKind!, updatedAt: new Date().toISOString() }).where(eq(recurringSeries.id, id)),
    db.insert(activityLog).values({
      entityType: "recurring_series",
      entityId: id,
      kind: "review",
      text: `${actorName(auth)} 將 ${current.name} 標為${body.cardKind === "bank" ? "銀行帳戶(不追蹤)" : "信用卡"}`,
      actorMemberId: auth.memberId,
    }),
  ]);
  return c.json({ ok: true });
});

cardsRoute.delete("/:id", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);
  const id = c.req.param("id");
  const db = createDb(c.env.DB);
  const current = await loadCard(db, id);
  if (!current) return c.json({ error: "not_found" }, 404);
  if (!visibleSeries(auth.scope, [current]).length) return c.json({ error: "forbidden" }, 403);
  const [docs, periods, marks, months, plans, reviews] = await Promise.all([
    db
      .select({ id: documentExtractedFields.documentId })
      .from(documentExtractedFields)
      .where(and(eq(documentExtractedFields.fieldKey, RECURRING_SERIES_FIELD_KEY), eq(documentExtractedFields.value, id)))
      .limit(1),
    db.select({ id: recurringPeriods.id }).from(recurringPeriods).where(eq(recurringPeriods.seriesId, id)).limit(1),
    db.select({ m: recurringMonthMarks.month }).from(recurringMonthMarks).where(eq(recurringMonthMarks.seriesId, id)).limit(1),
    db.select({ m: cardStatementMonths.month }).from(cardStatementMonths).where(eq(cardStatementMonths.seriesId, id)).limit(1),
    db.select({ id: installmentPlans.id }).from(installmentPlans).where(eq(installmentPlans.seriesId, id)).limit(1),
    db.select({ id: recurringMatchReviews.id }).from(recurringMatchReviews).where(eq(recurringMatchReviews.seriesId, id)).limit(1),
  ]);
  const linked = docs.length + periods.length + marks.length + months.length + plans.length + reviews.length;
  if (linked) return c.json({ error: "card_has_data", message: "這張卡已經連著帳單或分期,只能停用。" }, 409);
  await db.batch([
    db.delete(recurringSeries).where(eq(recurringSeries.id, id)),
    db.insert(activityLog).values({
      entityType: "recurring_series",
      entityId: id,
      kind: "review",
      text: `${actorName(auth)} 刪除信用卡 ${current.name}(沒有任何連結資料)`,
      actorMemberId: auth.memberId,
    }),
  ]);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// 每月應繳 / 已繳
// ---------------------------------------------------------------------------
cardsRoute.post("/:id/months/:month", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);
  const id = c.req.param("id");
  const month = c.req.param("month");
  if (!isValidMonth(month)) return c.json({ error: "invalid_month" }, 400);
  const body = await c.req.json<{ amountCents?: unknown; dueDate?: unknown; paid?: unknown; note?: unknown }>().catch(() => null);
  if (!body) return c.json({ error: "invalid_json" }, 400);
  const db = createDb(c.env.DB);
  const card = await loadCard(db, id);
  if (!card) return c.json({ error: "not_found" }, 404);
  if (!visibleSeries(auth.scope, [card]).length) return c.json({ error: "forbidden" }, 403);

  const set: Partial<typeof cardStatementMonths.$inferInsert> = {};
  if (body.amountCents !== undefined) {
    if (body.amountCents !== null && (typeof body.amountCents !== "number" || !Number.isInteger(body.amountCents) || body.amountCents < 0))
      return c.json({ error: "invalid_field", field: "amountCents" }, 400);
    set.amountCents = body.amountCents as number | null;
  }
  if (body.dueDate !== undefined) {
    if (body.dueDate !== null && body.dueDate !== "" && !(typeof body.dueDate === "string" && DATE_RE.test(body.dueDate)))
      return c.json({ error: "invalid_field", field: "dueDate" }, 400);
    set.dueDate = typeof body.dueDate === "string" && body.dueDate ? body.dueDate : null;
  }
  if (body.paid !== undefined) {
    if (typeof body.paid !== "boolean") return c.json({ error: "invalid_field", field: "paid" }, 400);
    set.paidAt = body.paid ? new Date().toISOString() : null;
  }
  if (body.note !== undefined) set.note = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 300) : null;
  if (!Object.keys(set).length) return c.json({ ok: true, unchanged: true });

  const now = new Date().toISOString();
  await db
    .insert(cardStatementMonths)
    .values({ seriesId: id, month, ...set, updatedByMemberId: auth.memberId, updatedAt: now })
    .onConflictDoUpdate({ target: [cardStatementMonths.seriesId, cardStatementMonths.month], set: { ...set, updatedByMemberId: auth.memberId, updatedAt: now } });
  return c.json({ ok: true });
});
