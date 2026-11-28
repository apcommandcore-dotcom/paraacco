"use client";

// 信用卡(2026-11-28,SPEC_cards-page_20261128.md)——取代導覽列的「對帳」。
//   [總覽] [卡片 A] [卡片 B] … [＋] [已停用 ▾]
//   - 總覽:本月各卡應繳(參考)、繳款截止、已繳、本月分期合計、分期未繳餘額。
//   - 單卡頁籤:近 12 個月帳單格(到了沒 / 應繳 / 已繳)、這張卡的分期、卡片設定。
//   - 停用代替刪除;只有完全沒連資料的卡能真刪(API 擋)。銀行帳戶對帳單不追蹤:卡片設定裡「這是銀行帳戶」= 隱藏。
// paraacco 只記支出:帳單金額不算支出、不進月報表;分期只看現金流(支出在發票月份已計入)。
// ?card=RCS-010 直接開某張卡;?newInstallment=DOC-… 從文件抽屜「設為分期」過來,帶入商家與金額。

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, Pencil, Plus } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Drawer } from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { centsToInput, formatCents } from "@/lib/format";
import {
  apiFetch,
  INSTALLMENT_STATE_LABELS,
  OWNERSHIP_LABELS,
  type CardMonthCell,
  type CardRow,
  type CardsResponse,
  type InstallmentPlanRow,
  type OwnershipScope,
  type VendorRow,
} from "@/lib/api";

const nt = (c: number | null | undefined) => formatCents(c);
const OWNERSHIP_KEYS = Object.keys(OWNERSHIP_LABELS) as OwnershipScope[];
const sel = "h-8 w-full border border-input bg-background px-2 text-xs";

function addMonth(m: string, n: number): string {
  const i = Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1 + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
}
function thisMonth(): string {
  const t = new Date(Date.now() + 8 * 3600e3);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}`;
}
const toCents = (v: string) => (v.trim() === "" ? null : Math.round(Number(v) * 100));
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function cardLabel(c: CardRow): string {
  const bank = c.vendorName ?? c.name;
  return c.accountRef ? `${bank} *${c.accountRef}` : bank;
}
function ownershipBadge(o: string | null) {
  if (o === "corp") return <Badge variant="corp">公司</Badge>;
  if (o === "per") return <Badge variant="per">個人</Badge>;
  if (o && o !== "pending") return <Badge variant="outline">{OWNERSHIP_LABELS[o as OwnershipScope] ?? o}</Badge>;
  return <Badge variant="outline">未分流</Badge>;
}

export default function CardsPage() {
  return (
    <Suspense>
      <CardsRoot />
    </Suspense>
  );
}

type Tab = "overview" | string;

function CardsRoot() {
  const router = useRouter();
  const params = useSearchParams();
  const [data, setData] = useState<CardsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [vendors, setVendors] = useState<VendorRow[]>([]);
  const [showInactive, setShowInactive] = useState(false);
  const [editingCard, setEditingCard] = useState<CardRow | "new" | null>(null);
  const [editingPlan, setEditingPlan] = useState<InstallmentPlanRow | PlanDraft | null>(null);
  const [cell, setCell] = useState<{ card: CardRow; cell: CardMonthCell } | null>(null);

  const tab: Tab = params.get("card") ?? "overview";
  const setTab = (t: Tab) => router.replace(t === "overview" ? "/cards" : `/cards?card=${t}`);

  const load = useCallback(() => {
    apiFetch<CardsResponse>("/api/cards")
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(errMsg(e)));
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    apiFetch<{ vendors: VendorRow[] }>("/api/vendors")
      .then((d) => setVendors(d.vendors))
      .catch(() => {});
  }, []);

  // 從文件抽屜「設為分期」過來:帶入商家、金額、歸屬
  const newInstallmentDoc = params.get("newInstallment");
  useEffect(() => {
    if (!newInstallmentDoc || !data) return;
    apiFetch<{ document: { id: string; vendorName?: string | null; vendorNameRaw: string | null; displayName?: string | null; amountCents: number | null; ownership: string } }>(
      `/api/documents/${newInstallmentDoc}`,
    )
      .then(({ document: d }) =>
        setEditingPlan({
          draft: true,
          seriesId: data.cards.find((c) => c.active)?.id ?? "",
          merchant: d.vendorName ?? d.vendorNameRaw ?? d.displayName ?? "",
          totalCents: d.amountCents,
          documentId: d.id,
          ownership: d.ownership,
        }),
      )
      .catch((e) => setError(errMsg(e)));
    router.replace("/cards");
  }, [newInstallmentDoc, data, router]);

  const cards = data?.cards ?? [];
  const activeCards = cards.filter((c) => c.active);
  const inactiveCards = cards.filter((c) => !c.active);
  const current = cards.find((c) => c.id === tab) ?? null;
  const plansOf = (id: string) => (data?.installments ?? []).filter((p) => p.seriesId === id);

  async function restoreBank(id: string) {
    await apiFetch(`/api/cards/${id}/kind`, { method: "POST", body: JSON.stringify({ cardKind: "credit_card" }) }).catch((e) => setError(errMsg(e)));
    load();
  }

  const tabCls = (on: boolean) =>
    `-mb-px whitespace-nowrap border-b-2 px-3 py-1.5 text-sm ${on ? "border-foreground font-semibold" : "border-transparent text-foreground-2 hover:text-foreground"}`;

  return (
    <AppShell>
      <div className="mb-1.5 flex flex-wrap items-baseline gap-2.5">
        <h1 className="m-0 text-[23px] font-extrabold tracking-tight">信用卡</h1>
        <span className="font-mono text-[10px] tracking-[0.16em] text-foreground-3">CARDS</span>
      </div>
      <p className="mb-4 text-sm text-foreground-2">
        每張卡的帳單到了沒、繳了沒、分期還剩多少。帳單金額只是參考,不算支出,也不進月報表;刷卡消費以發票計入。
      </p>
      {error && <div className="mb-3 border border-destructive-line bg-destructive-bg px-3 py-2 text-xs text-destructive">{error}</div>}

      <div className="mb-4 flex flex-wrap items-end gap-1 border-b border-line-2">
        <button type="button" className={tabCls(tab === "overview")} onClick={() => setTab("overview")}>
          總覽
        </button>
        {activeCards.map((c) => (
          <button key={c.id} type="button" className={tabCls(tab === c.id)} onClick={() => setTab(c.id)}>
            {cardLabel(c)}
          </button>
        ))}
        {showInactive &&
          inactiveCards.map((c) => (
            <button key={c.id} type="button" className={`${tabCls(tab === c.id)} text-foreground-3`} onClick={() => setTab(c.id)}>
              {cardLabel(c)}
              <span className="ml-1 text-[10px]">停用</span>
            </button>
          ))}
        <button type="button" className={tabCls(false)} onClick={() => setEditingCard("new")} title="新增卡片">
          <Plus size={14} />
        </button>
        {inactiveCards.length > 0 && (
          <button type="button" className={`${tabCls(false)} ml-auto text-xs`} onClick={() => setShowInactive((v) => !v)}>
            已停用 {inactiveCards.length}
            <ChevronDown size={12} className={`ml-0.5 inline transition-transform ${showInactive ? "rotate-180" : ""}`} />
          </button>
        )}
      </div>

      {!data && !error && <div className="text-sm text-muted-foreground">載入中…</div>}

      {data && tab === "overview" && (
        <Overview data={data} onOpen={setTab} onEditPlan={setEditingPlan} onNewPlan={() => setEditingPlan({ draft: true, seriesId: activeCards[0]?.id ?? "" })} />
      )}

      {data && tab !== "overview" && !current && <div className="text-sm text-muted-foreground">找不到這張卡。</div>}

      {data && current && (
        <CardTab
          card={current}
          plans={plansOf(current.id)}
          month={data.month}
          onEdit={() => setEditingCard(current)}
          onCell={(c) => setCell({ card: current, cell: c })}
          onNewPlan={() => setEditingPlan({ draft: true, seriesId: current.id })}
          onEditPlan={setEditingPlan}
        />
      )}

      {data && data.hiddenBanks.length > 0 && (
        <div className="mt-8 text-xs text-foreground-3">
          已隱藏的銀行帳戶(不追蹤,文件仍可在依標題瀏覽與搜尋找到):
          {data.hiddenBanks.map((b) => (
            <span key={b.id} className="ml-2">
              {b.name}
              <button type="button" className="ml-1 text-primary hover:underline" onClick={() => restoreBank(b.id)}>
                改回信用卡
              </button>
            </span>
          ))}
        </div>
      )}

      <CardDrawer
        editing={editingCard}
        vendors={vendors}
        onClose={() => setEditingCard(null)}
        onSaved={(id) => {
          setEditingCard(null);
          load();
          if (id === null) setTab("overview");
          else if (id) setTab(id);
        }}
      />
      <PlanDrawer editing={editingPlan} cards={cards} onClose={() => setEditingPlan(null)} onSaved={() => (setEditingPlan(null), load())} />
      <MonthDrawer selected={cell} onClose={() => setCell(null)} onSaved={() => (setCell(null), load())} />
    </AppShell>
  );
}

// ---------------------------------------------------------------------------
// 總覽
// ---------------------------------------------------------------------------
function Overview({
  data,
  onOpen,
  onEditPlan,
  onNewPlan,
}: {
  data: CardsResponse;
  onOpen: (id: string) => void;
  onEditPlan: (p: InstallmentPlanRow) => void;
  onNewPlan: () => void;
}) {
  const active = data.cards.filter((c) => c.active);
  const plans = data.installments.filter((p) => p.progress.state === "active" || p.progress.state === "upcoming");
  const rows = active.map((c) => {
    const cur = c.months.find((m) => m.month === data.month) ?? null;
    const prev = c.months.find((m) => m.month === addMonth(data.month, -1)) ?? null;
    const mine = plans.filter((p) => p.seriesId === c.id);
    return {
      card: c,
      cur,
      prev,
      planThisMonth: mine.reduce((s, p) => s + p.progress.thisMonthCents, 0),
      planRemaining: mine.reduce((s, p) => s + p.progress.remainingCents, 0),
    };
  });
  const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((s, r) => s + f(r), 0);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi label={`${data.month} 帳單應繳(參考)`} value={nt(sum((r) => r.cur?.amountCents ?? 0))} />
        <Kpi label="本月未標已繳" value={`${rows.filter((r) => r.cur && r.cur.documentIds.length && !r.cur.paidAt).length} 張`} />
        <Kpi label="本月分期合計" value={nt(sum((r) => r.planThisMonth))} />
        <Kpi label="分期未繳餘額" value={nt(sum((r) => r.planRemaining))} />
      </div>

      <Card>
        <CardContent className="p-0">
          <Table className="text-xs">
            <TableHeader>
              <TableRow>
                <TableHead>卡片</TableHead>
                <TableHead>歸屬</TableHead>
                <TableHead>上月帳單</TableHead>
                <TableHead>本月帳單</TableHead>
                <TableHead className="text-right">應繳(參考)</TableHead>
                <TableHead>繳款截止</TableHead>
                <TableHead>已繳</TableHead>
                <TableHead className="text-right">本月分期</TableHead>
                <TableHead className="text-right">分期餘額</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(({ card, cur, prev, planThisMonth, planRemaining }) => (
                <TableRow key={card.id}>
                  <TableCell className="whitespace-nowrap">
                    <button type="button" className="font-semibold text-primary hover:underline" onClick={() => onOpen(card.id)}>
                      {cardLabel(card)}
                    </button>
                    <div className="text-[10px] text-foreground-3">{card.name}</div>
                  </TableCell>
                  <TableCell>{ownershipBadge(card.ownership)}</TableCell>
                  <TableCell>{prev ? <ArrivalBadge cell={prev} /> : "—"}</TableCell>
                  <TableCell>{cur ? <ArrivalBadge cell={cur} /> : "—"}</TableCell>
                  <TableCell className="text-right font-mono">{nt(cur?.amountCents)}</TableCell>
                  <TableCell className="whitespace-nowrap font-mono">{cur?.dueDate ?? (card.dueDay ? `每月 ${card.dueDay} 日` : "—")}</TableCell>
                  <TableCell>{cur?.paidAt ? <Badge variant="success">已繳</Badge> : <span className="text-foreground-3">—</span>}</TableCell>
                  <TableCell className="text-right font-mono">{planThisMonth ? nt(planThisMonth) : "—"}</TableCell>
                  <TableCell className="text-right font-mono">{planRemaining ? nt(planRemaining) : "—"}</TableCell>
                </TableRow>
              ))}
              {!rows.length && (
                <TableRow>
                  <TableCell colSpan={9} className="py-6 text-center text-muted-foreground">
                    還沒有卡片。按頁籤列的「＋」新增。
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <PlanTable title="進行中的分期" plans={plans} cards={data.cards} showCard onEdit={onEditPlan} onNew={onNewPlan} />
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-line bg-card px-3 py-2">
      <div className="text-[11px] text-foreground-3">{label}</div>
      <div className="mt-0.5 font-mono text-lg font-semibold">{value}</div>
    </div>
  );
}

function ArrivalBadge({ cell }: { cell: CardMonthCell }) {
  if (cell.documentIds.length) return <Badge variant="success">已到</Badge>;
  if (cell.mark === "not_required") return <Badge variant="default">無消費</Badge>;
  if (cell.mark === "encrypted") return <Badge variant="info">加密</Badge>;
  if (!cell.inRange) return <span className="text-foreground-3">—</span>;
  return <Badge variant="outline">未到</Badge>;
}

// ---------------------------------------------------------------------------
// 單卡頁籤
// ---------------------------------------------------------------------------
function CardTab({
  card,
  plans,
  month,
  onEdit,
  onCell,
  onNewPlan,
  onEditPlan,
}: {
  card: CardRow;
  plans: InstallmentPlanRow[];
  month: string;
  onEdit: () => void;
  onCell: (c: CardMonthCell) => void;
  onNewPlan: () => void;
  onEditPlan: (p: InstallmentPlanRow) => void;
}) {
  const info: [string, React.ReactNode][] = [
    ["卡名", card.name],
    ["銀行", card.vendorName ?? "—"],
    ["末四碼", card.accountRef ?? "—"],
    ["歸屬", ownershipBadge(card.ownership)],
    ["結帳日", card.statementDay ? `每月 ${card.statementDay} 日` : "—"],
    ["繳款日", card.dueDay ? `每月 ${card.dueDay} 日` : "—"],
    ["扣款帳戶", card.debitAccount ?? "—"],
    ["使用期間", `${card.startMonth} ~ ${card.endMonth ?? "使用中"}`],
  ];
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4">
          {info.map(([k, v]) => (
            <div key={k}>
              <dt className="text-foreground-3">{k}</dt>
              <dd className="m-0">{v}</dd>
            </div>
          ))}
        </dl>
        <Button size="sm" variant="outline" onClick={onEdit}>
          <Pencil size={13} className="mr-1" />
          卡片設定
        </Button>
      </div>
      {!card.active && <div className="border border-line bg-muted px-3 py-2 text-xs text-foreground-2">這張卡已停用(最後帳單月份 {card.endMonth})。到「卡片設定」可以重新啟用。</div>}

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">近 12 個月帳單</h3>
        <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-6 lg:grid-cols-12">
          {card.months.map((m) => (
            <button
              key={m.month}
              type="button"
              onClick={() => onCell(m)}
              disabled={!m.inRange && !m.documentIds.length}
              className={`border px-1.5 py-1.5 text-left text-[11px] disabled:opacity-40 ${
                m.paidAt
                  ? "border-ok-line bg-ok-bg"
                  : m.documentIds.length
                    ? "border-info-line bg-info-bg"
                    : m.mark
                      ? "border-line bg-muted"
                      : "border-line bg-transparent"
              } ${m.month === month ? "ring-1 ring-foreground" : ""}`}
            >
              <div className="font-mono text-foreground-3">{m.month.slice(2)}</div>
              <div className="mt-0.5">
                {m.paidAt ? "✓ 已繳" : m.documentIds.length ? "● 已到" : m.mark === "not_required" ? "— 無消費" : m.mark === "encrypted" ? "鎖 加密" : m.inRange ? "○ 未到" : ""}
              </div>
              <div className="font-mono">{m.amountCents != null ? nt(m.amountCents) : " "}</div>
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-[11px] text-foreground-3">點格子可記應繳金額、繳款截止,或標成已繳。帳單文件掛上後會自動顯示「已到」。</p>
      </section>

      <PlanTable title="這張卡的分期" plans={plans} cards={[card]} onEdit={onEditPlan} onNew={card.active ? onNewPlan : undefined} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 分期清單
// ---------------------------------------------------------------------------
function PlanTable({
  title,
  plans,
  cards,
  showCard,
  onEdit,
  onNew,
}: {
  title: string;
  plans: InstallmentPlanRow[];
  cards: CardRow[];
  showCard?: boolean;
  onEdit: (p: InstallmentPlanRow) => void;
  onNew?: () => void;
}) {
  const [showDone, setShowDone] = useState(false);
  const live = plans.filter((p) => p.progress.state === "active" || p.progress.state === "upcoming");
  const done = plans.filter((p) => !live.includes(p));
  const list = showDone ? [...live, ...done] : live;
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">{title}</h3>
        <div className="flex items-center gap-3">
          {done.length > 0 && (
            <button type="button" className="text-xs text-foreground-3 hover:text-foreground" onClick={() => setShowDone((v) => !v)}>
              {showDone ? "隱藏" : "顯示"}已繳完 / 已結束 {done.length}
            </button>
          )}
          {onNew && (
            <Button size="sm" variant="outline" onClick={onNew}>
              <Plus size={13} className="mr-1" />
              新增分期
            </Button>
          )}
        </div>
      </div>
      <Card>
        <CardContent className="p-0">
          <Table className="text-xs">
            <TableHeader>
              <TableRow>
                <TableHead>商家</TableHead>
                {showCard && <TableHead>卡片</TableHead>}
                <TableHead>歸屬</TableHead>
                <TableHead className="text-right">原始金額</TableHead>
                <TableHead className="text-right">每期</TableHead>
                <TableHead>進度</TableHead>
                <TableHead>期間</TableHead>
                <TableHead className="text-right">本月</TableHead>
                <TableHead className="text-right">未繳餘額</TableHead>
                <TableHead>發票</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((p) => {
                const card = cards.find((c) => c.id === p.seriesId);
                return (
                  <TableRow key={p.id} className={live.includes(p) ? "" : "text-foreground-3"}>
                    <TableCell className="font-semibold">{p.merchant}</TableCell>
                    {showCard && <TableCell className="whitespace-nowrap">{card ? cardLabel(card) : p.seriesId}</TableCell>}
                    <TableCell>{ownershipBadge(p.ownership)}</TableCell>
                    <TableCell className="text-right font-mono">{nt(p.totalCents)}</TableCell>
                    <TableCell className="text-right font-mono">{nt(p.perPeriodCents)}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {p.progress.state === "cancelled" ? INSTALLMENT_STATE_LABELS.cancelled : `${p.progress.billedCount} / ${p.periodCount} 期`}
                      {p.progress.state === "upcoming" && <span className="ml-1 text-foreground-3">(未開始)</span>}
                    </TableCell>
                    <TableCell className="whitespace-nowrap font-mono">
                      {p.firstMonth} ~ {p.progress.lastMonth}
                    </TableCell>
                    <TableCell className="text-right font-mono">{p.progress.thisMonthCents ? nt(p.progress.thisMonthCents) : "—"}</TableCell>
                    <TableCell className="text-right font-mono">{p.progress.remainingCents ? nt(p.progress.remainingCents) : "—"}</TableCell>
                    <TableCell>
                      {p.documentId ? (
                        <Link href={`/documents?id=${p.documentId}`} className="font-mono text-primary hover:underline">
                          {p.documentId}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell>
                      <button type="button" className="text-foreground-3 hover:text-foreground" onClick={() => onEdit(p)} title="編輯">
                        <Pencil size={13} />
                      </button>
                    </TableCell>
                  </TableRow>
                );
              })}
              {!list.length && (
                <TableRow>
                  <TableCell colSpan={showCard ? 11 : 10} className="py-5 text-center text-muted-foreground">
                    沒有進行中的分期。也可以在發票的詳情按「設為分期」。
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 卡片設定(新增 / 編輯 / 停用 / 銀行帳戶 / 刪除)
// ---------------------------------------------------------------------------
interface CardForm {
  name: string;
  vendorId: string;
  accountRef: string;
  ownership: string;
  statementDay: string;
  dueDay: string;
  debitAccount: string;
  startMonth: string;
  endMonth: string;
  note: string;
}

function CardDrawer({
  editing,
  vendors,
  onClose,
  onSaved,
}: {
  editing: CardRow | "new" | null;
  vendors: VendorRow[];
  onClose: () => void;
  /** id = 存檔後要切過去的卡;null = 刪除了(回總覽);undefined = 停在原頁籤。 */
  onSaved: (id?: string | null) => void;
}) {
  const current = editing && editing !== "new" ? editing : null;
  const [form, setForm] = useState<CardForm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!editing) return setForm(null);
    setError(null);
    const c = editing === "new" ? null : editing;
    setForm({
      name: c?.name ?? "",
      vendorId: c?.vendorId ?? "",
      accountRef: c?.accountRef ?? "",
      ownership: c?.ownership ?? "corp",
      statementDay: c?.statementDay ? String(c.statementDay) : "",
      dueDay: c?.dueDay ? String(c.dueDay) : "",
      debitAccount: c?.debitAccount ?? "",
      startMonth: c?.startMonth ?? thisMonth(),
      endMonth: c?.endMonth ?? "",
      note: c?.note ?? "",
    });
  }, [editing]);

  if (!form) return <Drawer open={false} onClose={onClose} title="">{null}</Drawer>;
  const set = (k: keyof CardForm, v: string) => setForm({ ...form, [k]: v });
  const day = (v: string) => (v.trim() ? Number(v) : null);

  async function call(fn: () => Promise<unknown>, after: () => void) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      after();
    } catch (e) {
      const m = errMsg(e);
      setError(m.includes("card_has_data") ? "這張卡已經連著帳單或分期,只能停用。" : m);
    } finally {
      setBusy(false);
    }
  }

  function save() {
    const body = {
      name: form!.name,
      vendorId: form!.vendorId || null,
      accountRef: form!.accountRef || null,
      ownership: form!.ownership || null,
      statementDay: day(form!.statementDay),
      dueDay: day(form!.dueDay),
      debitAccount: form!.debitAccount || null,
      startMonth: form!.startMonth,
      endMonth: form!.endMonth || null,
      note: form!.note || null,
    };
    if (current) call(() => apiFetch(`/api/cards/${current.id}`, { method: "POST", body: JSON.stringify(body) }), () => onSaved());
    else call(() => apiFetch<{ id: string }>("/api/cards", { method: "POST", body: JSON.stringify(body) }).then((r) => r.id), () => onSaved());
  }
  async function create() {
    setBusy(true);
    setError(null);
    try {
      const r = await apiFetch<{ id: string }>("/api/cards", {
        method: "POST",
        body: JSON.stringify({
          name: form!.name,
          vendorId: form!.vendorId || null,
          accountRef: form!.accountRef || null,
          ownership: form!.ownership || null,
          statementDay: day(form!.statementDay),
          dueDay: day(form!.dueDay),
          debitAccount: form!.debitAccount || null,
          startMonth: form!.startMonth,
          note: form!.note || null,
        }),
      });
      onSaved(r.id);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }
  function deactivate() {
    const end = prompt("最後一期帳單月份(YYYY-MM)?之後的月份不再顯示。", addMonth(thisMonth(), -1));
    if (!end || !/^\d{4}-\d{2}$/.test(end)) return;
    call(() => apiFetch(`/api/cards/${current!.id}`, { method: "POST", body: JSON.stringify({ endMonth: end }) }), () => onSaved());
  }
  function reactivate() {
    call(() => apiFetch(`/api/cards/${current!.id}`, { method: "POST", body: JSON.stringify({ endMonth: null }) }), () => onSaved());
  }
  function markBank() {
    if (!confirm(`「${current!.name}」是銀行帳戶的對帳單,不是信用卡?標記後不再追蹤,也不在這一頁顯示(頁尾可以改回)。`)) return;
    call(() => apiFetch(`/api/cards/${current!.id}/kind`, { method: "POST", body: JSON.stringify({ cardKind: "bank" }) }), () => onSaved(null));
  }
  function remove() {
    if (!confirm(`刪除「${current!.name}」?只有完全沒連帳單或分期的卡才能刪,刪了不能復原。`)) return;
    call(() => apiFetch(`/api/cards/${current!.id}`, { method: "DELETE" }), () => onSaved(null));
  }

  const canSave = !busy && form.name.trim() && /^\d{4}-\d{2}$/.test(form.startMonth) && (!form.accountRef || /^\d{4}$/.test(form.accountRef));
  const banks = vendors.filter((v) => /銀行|商銀|信用卡|Bank|American Express/i.test(v.name));
  const vendorOptions = banks.length ? banks : vendors;
  return (
    <Drawer open={!!editing} onClose={onClose} title={current ? `卡片設定 · ${current.name}` : "新增卡片"}>
      <div className="grid grid-cols-2 gap-3 text-xs">
        <F label="卡名" wide>
          <Input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="例:國泰世華 CUBE 卡" className="h-8 text-xs" />
        </F>
        <F label="銀行">
          <select value={form.vendorId} onChange={(e) => set("vendorId", e.target.value)} className={sel}>
            <option value="">—</option>
            {vendorOptions.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
            {form.vendorId && !vendorOptions.some((v) => v.id === form.vendorId) && <option value={form.vendorId}>{vendors.find((v) => v.id === form.vendorId)?.name ?? form.vendorId}</option>}
          </select>
        </F>
        <F label="末四碼(帳單自動掛卡用)">
          <Input value={form.accountRef} onChange={(e) => set("accountRef", e.target.value.replace(/\D/g, "").slice(0, 4))} className="h-8 font-mono text-xs" />
        </F>
        <F label="預設歸屬(分期會帶入,可單筆改)">
          <select value={form.ownership} onChange={(e) => set("ownership", e.target.value)} className={sel}>
            {OWNERSHIP_KEYS.map((k) => (
              <option key={k} value={k}>
                {OWNERSHIP_LABELS[k]}
              </option>
            ))}
            <option value="pending">未分流</option>
          </select>
        </F>
        <F label="扣款帳戶(純文字)">
          <Input value={form.debitAccount} onChange={(e) => set("debitAccount", e.target.value)} placeholder="例:玉山綜合" className="h-8 text-xs" />
        </F>
        <F label="結帳日">
          <Input type="number" min={1} max={31} value={form.statementDay} onChange={(e) => set("statementDay", e.target.value)} className="h-8 text-xs" />
        </F>
        <F label="繳款日">
          <Input type="number" min={1} max={31} value={form.dueDay} onChange={(e) => set("dueDay", e.target.value)} className="h-8 text-xs" />
        </F>
        <F label="開始使用(YYYY-MM)">
          <Input value={form.startMonth} onChange={(e) => set("startMonth", e.target.value)} className="h-8 font-mono text-xs" />
        </F>
        {current && (
          <F label="最後帳單月份(停用)">
            <Input value={form.endMonth} onChange={(e) => set("endMonth", e.target.value)} placeholder="使用中" className="h-8 font-mono text-xs" />
          </F>
        )}
        <F label="備註" wide>
          <Input value={form.note} onChange={(e) => set("note", e.target.value)} className="h-8 text-xs" />
        </F>
      </div>
      {error && <div className="mt-3 text-xs text-destructive">{error}</div>}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button size="sm" variant="outline" onClick={onClose}>
          取消
        </Button>
        <Button size="sm" disabled={!canSave} onClick={current ? save : create}>
          儲存
        </Button>
      </div>
      {current && (
        <div className="mt-6 space-y-2 border-t border-line pt-4 text-xs">
          {current.endMonth ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={reactivate}>
              重新啟用
            </Button>
          ) : (
            <Button size="sm" variant="outline" disabled={busy} onClick={deactivate}>
              停用這張卡
            </Button>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy} className="text-foreground-3 hover:text-foreground hover:underline" onClick={markBank}>
              這是銀行帳戶(不追蹤)
            </button>
            <button type="button" disabled={busy} className="ml-auto text-destructive hover:underline" onClick={remove}>
              刪除(只限建錯的卡)
            </button>
          </div>
        </div>
      )}
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
// 分期(新增 / 編輯 / 結束 / 刪除)
// ---------------------------------------------------------------------------
interface PlanDraft {
  draft: true;
  seriesId: string;
  merchant?: string;
  totalCents?: number | null;
  documentId?: string;
  ownership?: string;
}

function PlanDrawer({
  editing,
  cards,
  onClose,
  onSaved,
}: {
  editing: InstallmentPlanRow | PlanDraft | null;
  cards: CardRow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const current = editing && !("draft" in editing) ? editing : null;
  const [form, setForm] = useState<{
    seriesId: string;
    merchant: string;
    total: string;
    count: string;
    per: string;
    perTouched: boolean;
    firstMonth: string;
    ownership: string;
    documentId: string;
    note: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!editing) return setForm(null);
    setError(null);
    if ("draft" in editing) {
      const card = cards.find((c) => c.id === editing.seriesId);
      setForm({
        seriesId: editing.seriesId,
        merchant: editing.merchant ?? "",
        total: centsToInput(editing.totalCents ?? null),
        count: "",
        per: "",
        perTouched: false,
        firstMonth: addMonth(thisMonth(), 1),
        ownership: editing.ownership ?? card?.ownership ?? "corp",
        documentId: editing.documentId ?? "",
        note: "",
      });
    } else {
      setForm({
        seriesId: editing.seriesId,
        merchant: editing.merchant,
        total: centsToInput(editing.totalCents),
        count: String(editing.periodCount),
        per: centsToInput(editing.perPeriodCents),
        perTouched: true,
        firstMonth: editing.firstMonth,
        ownership: editing.ownership ?? "corp",
        documentId: editing.documentId ?? "",
        note: editing.note ?? "",
      });
    }
  }, [editing, cards]);

  const preview = useMemo(() => {
    if (!form) return null;
    const total = toCents(form.total);
    const count = Number(form.count);
    if (!total || !Number.isInteger(count) || count < 1) return null;
    const per = form.perTouched ? toCents(form.per) : Math.floor(total / count / 100) * 100;
    if (!per) return null;
    const last = total - per * (count - 1);
    return { per, last, lastMonth: /^\d{4}-\d{2}$/.test(form.firstMonth) ? addMonth(form.firstMonth, count - 1) : null, ok: last >= 0 && per <= total };
  }, [form]);

  if (!form) return <Drawer open={false} onClose={onClose} title="">{null}</Drawer>;
  const set = (k: keyof NonNullable<typeof form>, v: string) => setForm({ ...form, [k]: v, ...(k === "per" ? { perTouched: true } : {}) });

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onSaved();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }
  function save() {
    if (!preview?.ok) return;
    const body = {
      seriesId: form!.seriesId,
      merchant: form!.merchant,
      totalCents: toCents(form!.total),
      periodCount: Number(form!.count),
      perPeriodCents: preview.per,
      firstMonth: form!.firstMonth,
      ownership: form!.ownership || null,
      documentId: form!.documentId.trim() || null,
      note: form!.note || null,
    };
    run(() => apiFetch(current ? `/api/cards/installments/${current.id}` : "/api/cards/installments", { method: "POST", body: JSON.stringify(body) }));
  }

  const activeCards = cards.filter((c) => c.active || c.id === form.seriesId);
  const canSave = !busy && form.seriesId && form.merchant.trim() && /^\d{4}-\d{2}$/.test(form.firstMonth) && preview?.ok;
  return (
    <Drawer open={!!editing} onClose={onClose} title={current ? `編輯分期 · ${current.merchant}` : "新增分期"}>
      <div className="grid grid-cols-2 gap-3 text-xs">
        <F label="卡片" wide>
          <select
            value={form.seriesId}
            onChange={(e) => {
              const card = cards.find((c) => c.id === e.target.value);
              setForm({ ...form, seriesId: e.target.value, ownership: current ? form.ownership : (card?.ownership ?? form.ownership) });
            }}
            className={sel}
          >
            <option value="">選一張卡</option>
            {activeCards.map((c) => (
              <option key={c.id} value={c.id}>
                {cardLabel(c)} · {c.name}
              </option>
            ))}
          </select>
        </F>
        <F label="商家" wide>
          <Input value={form.merchant} onChange={(e) => set("merchant", e.target.value)} className="h-8 text-xs" />
        </F>
        <F label="原始金額(元)">
          <Input type="number" min={0} value={form.total} onChange={(e) => set("total", e.target.value)} className="h-8 font-mono text-xs" />
        </F>
        <F label="期數">
          <Input type="number" min={1} max={120} value={form.count} onChange={(e) => set("count", e.target.value)} className="h-8 font-mono text-xs" />
        </F>
        <F label="每期金額(元,留空自動算)">
          <Input
            type="number"
            min={0}
            value={form.perTouched ? form.per : preview ? String(preview.per / 100) : ""}
            onChange={(e) => (e.target.value === "" ? setForm({ ...form, per: "", perTouched: false }) : set("per", e.target.value))}
            className="h-8 font-mono text-xs"
          />
        </F>
        <F label="首期帳單月份(YYYY-MM)">
          <Input value={form.firstMonth} onChange={(e) => set("firstMonth", e.target.value)} className="h-8 font-mono text-xs" />
        </F>
        <F label="歸屬">
          <select value={form.ownership} onChange={(e) => set("ownership", e.target.value)} className={sel}>
            {OWNERSHIP_KEYS.map((k) => (
              <option key={k} value={k}>
                {OWNERSHIP_LABELS[k]}
              </option>
            ))}
            <option value="pending">未分流</option>
          </select>
        </F>
        <F label="原始發票(選填,DOC-…)">
          <Input value={form.documentId} onChange={(e) => set("documentId", e.target.value)} className="h-8 font-mono text-xs" />
        </F>
        <F label="備註" wide>
          <Input value={form.note} onChange={(e) => set("note", e.target.value)} className="h-8 text-xs" />
        </F>
      </div>
      {preview && (
        <div className={`mt-3 text-xs ${preview.ok ? "text-foreground-2" : "text-destructive"}`}>
          {preview.ok
            ? `每期 ${nt(preview.per)}${preview.last !== preview.per ? `,最後一期 ${nt(preview.last)}` : ""};${form.firstMonth} ~ ${preview.lastMonth ?? "?"}`
            : "每期金額太高:每期 × 期數超過原始金額。"}
        </div>
      )}
      <p className="mt-2 text-[11px] text-foreground-3">分期只看現金流,不計入月報表(支出已在發票月份計入)。</p>
      {error && <div className="mt-3 text-xs text-destructive">{error}</div>}
      <div className="mt-4 flex justify-end gap-2">
        <Button size="sm" variant="outline" onClick={onClose}>
          取消
        </Button>
        <Button size="sm" disabled={!canSave} onClick={save}>
          儲存
        </Button>
      </div>
      {current && (
        <div className="mt-6 flex flex-wrap gap-3 border-t border-line pt-4 text-xs">
          {current.status === "active" ? (
            <button
              type="button"
              disabled={busy}
              className="text-foreground-2 hover:underline"
              onClick={() =>
                confirm("提前清償或取消這筆分期?之後的期數不再計算。") &&
                run(() => apiFetch(`/api/cards/installments/${current.id}`, { method: "POST", body: JSON.stringify({ status: "cancelled" }) }))
              }
            >
              結束分期(提前清償)
            </button>
          ) : (
            <button
              type="button"
              disabled={busy}
              className="text-foreground-2 hover:underline"
              onClick={() => run(() => apiFetch(`/api/cards/installments/${current.id}`, { method: "POST", body: JSON.stringify({ status: "active" }) }))}
            >
              恢復分期
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            className="ml-auto text-destructive hover:underline"
            onClick={() => confirm(`刪除「${current.merchant}」這筆分期?(輸入錯誤才用;提前清償請用「結束分期」)`) && run(() => apiFetch(`/api/cards/installments/${current.id}`, { method: "DELETE" }))}
          >
            刪除
          </button>
        </div>
      )}
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
// 某個月的帳單:文件、應繳(參考)、繳款截止、已繳
// ---------------------------------------------------------------------------
function MonthDrawer({ selected, onClose, onSaved }: { selected: { card: CardRow; cell: CardMonthCell } | null; onClose: () => void; onSaved: () => void }) {
  const [amount, setAmount] = useState("");
  const [due, setDue] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!selected) return;
    setError(null);
    setAmount(selected.cell.amountSource === "manual" ? centsToInput(selected.cell.amountCents) : "");
    setDue(selected.cell.dueDate ?? "");
    setNote(selected.cell.note ?? "");
  }, [selected]);

  if (!selected) return <Drawer open={false} onClose={onClose} title="">{null}</Drawer>;
  const { card, cell } = selected;

  async function post(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/cards/${card.id}/months/${cell.month}`, { method: "POST", body: JSON.stringify(body) });
      onSaved();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }
  const fields = () => ({ amountCents: toCents(amount), dueDate: due || null, note: note || null });

  return (
    <Drawer open onClose={onClose} title={`${cardLabel(card)} · ${cell.month} 帳單`}>
      <div className="space-y-4 text-xs">
        <section>
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-widest text-muted-foreground">帳單文件</h3>
          {cell.documentIds.length ? (
            <ul className="space-y-1">
              {cell.documentIds.map((d) => (
                <li key={d}>
                  <Link href={`/documents?id=${d}`} className="font-mono text-primary hover:underline">
                    {d}
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-foreground-3">
              {cell.mark === "not_required" ? "已標記:當月無消費。" : cell.mark === "encrypted" ? "只有加密原檔,讀不到。" : "這個月還沒有帳單文件。"}
            </div>
          )}
        </section>
        <div className="grid grid-cols-2 gap-3">
          <F label={`應繳金額(元,參考)${cell.amountSource === "document" ? ` · 帳單上是 ${nt(cell.amountCents)}` : ""}`} wide>
            <Input type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={cell.amountSource === "document" ? "留空沿用帳單金額" : ""} className="h-8 font-mono text-xs" />
          </F>
          <F label="繳款截止">
            <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} className="h-8 text-xs" />
          </F>
          <F label="狀態">
            <div className="flex h-8 items-center">{cell.paidAt ? <Badge variant="success">已繳 · {cell.paidAt.slice(0, 10)}</Badge> : <span className="text-foreground-3">未標已繳</span>}</div>
          </F>
          <F label="備註" wide>
            <Input value={note} onChange={(e) => setNote(e.target.value)} className="h-8 text-xs" />
          </F>
        </div>
        {error && <div className="text-destructive">{error}</div>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => post(fields())}>
            只存金額/日期
          </Button>
          {cell.paidAt ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => post({ ...fields(), paid: false })}>
              取消已繳
            </Button>
          ) : (
            <Button size="sm" disabled={busy} onClick={() => post({ ...fields(), paid: true })}>
              標成已繳
            </Button>
          )}
        </div>
      </div>
    </Drawer>
  );
}

function F({ label, wide, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <label className={`block ${wide ? "col-span-2" : ""}`}>
      <span className="mb-1 block text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
