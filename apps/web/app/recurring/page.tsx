"use client";

// 定期帳單月份檢核(2026-09-28,CODE_TASK_local-originals-nas-path_20260927_V1.01.md 第六節 4)——
// 每個 series(水費、某張信用卡、某個投保單位的健保…)× 月份的格狀表:有/缺/只有催繳/加密/無需帳單。
// 點格子看對應文件;沒有文件的月份可以手動標「無需帳單」(例如信用卡當月無消費)或「加密」
// (只有讀不到的加密原檔,放在 90_無法處理)。資料來自 GET /api/recurring/coverage,月份由覆核頁
// 確認的 billing_month 欄位決定。配色沿用 ok/warn/err/info 語意色(見 ui/badge.tsx)。

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertCircle } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Drawer } from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import {
  apiFetch,
  CADENCE_LABELS,
  COVERAGE_STATUS_LABELS,
  OWNERSHIP_LABELS,
  type CoverageCell,
  type CoverageResponse,
  type CoverageSeries,
  type CoverageStatus,
  type OwnershipScope,
} from "@/lib/api";

const STATUS_CLASS: Record<CoverageStatus, string> = {
  present: "border-ok-line bg-ok-bg text-ok",
  reminder_only: "border-warning-line bg-warning-bg text-warning",
  encrypted: "border-info-line bg-info-bg text-info",
  not_required: "border-line bg-muted text-foreground-3",
  missing: "border-destructive-line bg-destructive-bg text-destructive",
};

const STATUS_GLYPH: Record<CoverageStatus, string> = {
  present: "●",
  reminder_only: "!",
  encrypted: "鎖",
  not_required: "—",
  missing: "✕",
};

function monthIndex(m: string): number {
  return Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;
}

function monthFromIndex(i: number): string {
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
}

function defaultRange(): { from: string; to: string } {
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const last = now.getUTCFullYear() * 12 + now.getUTCMonth() - 1;
  return { from: monthFromIndex(last - 23), to: monthFromIndex(last) };
}

function RecurringRoot() {
  const initial = useMemo(defaultRange, []);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [data, setData] = useState<CoverageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ series: CoverageSeries; cell: CoverageCell } | null>(null);
  const [onlyGaps, setOnlyGaps] = useState(false);

  const load = useCallback(() => {
    setError(null);
    apiFetch<CoverageResponse>(`/api/recurring/coverage?from=${from}&to=${to}`)
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [from, to]);

  useEffect(load, [load]);

  const months = useMemo(() => {
    if (!data) return [];
    const out: string[] = [];
    for (let i = monthIndex(data.from); i <= monthIndex(data.to); i++) out.push(monthFromIndex(i));
    return out;
  }, [data]);

  const rows = (data?.series ?? []).filter((s) => !onlyGaps || s.summary.missing > 0);
  const totals = (data?.series ?? []).reduce(
    (acc, s) => ({ expected: acc.expected + s.summary.expected, missing: acc.missing + s.summary.missing, present: acc.present + s.summary.present }),
    { expected: 0, missing: 0, present: 0 },
  );

  return (
    <AppShell>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-wide">定期帳單月份檢核</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            月份依覆核時確認的「帳單月份」計算。信用卡、證券的「缺」不一定是漏存——沒有消費/交易的月份可以標成「無需帳單」。
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2 text-xs">
          <label>
            <span className="mb-1 block text-muted-foreground">起</span>
            <Input type="month" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} className="h-8 w-[140px] text-xs" />
          </label>
          <label>
            <span className="mb-1 block text-muted-foreground">迄</span>
            <Input type="month" value={to} onChange={(e) => e.target.value && setTo(e.target.value)} className="h-8 w-[140px] text-xs" />
          </label>
          <label className="flex h-8 items-center gap-1.5">
            <input type="checkbox" checked={onlyGaps} onChange={(e) => setOnlyGaps(e.target.checked)} />
            只看有缺的
          </label>
        </div>
      </div>

      {error && (
        <div className="mb-4 flex items-center gap-2 border border-destructive-line bg-destructive-bg p-3 text-sm text-destructive">
          <AlertCircle size={14} />
          {error}
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
        {(Object.keys(COVERAGE_STATUS_LABELS) as CoverageStatus[]).map((s) => (
          <span key={s} className="inline-flex items-center gap-1.5">
            <span className={`inline-flex h-4 w-4 items-center justify-center border text-[9px] ${STATUS_CLASS[s]}`}>{STATUS_GLYPH[s]}</span>
            {COVERAGE_STATUS_LABELS[s]}
          </span>
        ))}
        {data && (
          <span className="ml-auto font-mono">
            應有 {totals.expected} · 有 {totals.present} · 缺 {totals.missing}
          </span>
        )}
      </div>

      <Card>
        <CardContent className="overflow-x-auto p-0">
          {!data && !error && <div className="p-4 text-sm text-muted-foreground">載入中…</div>}
          {data && data.series.length === 0 && (
            <div className="p-4 text-sm text-muted-foreground">還沒有定期帳單項目(recurring_series 尚未建立初始資料)。</div>
          )}
          {data && rows.length > 0 && (
            <table className="border-collapse text-xs">
              <thead>
                <tr className="border-b border-border">
                  <th className="sticky left-0 z-10 min-w-[140px] bg-card px-3 py-2 md:min-w-[200px] text-left font-medium">帳單</th>
                  <th className="px-2 py-2 text-right font-medium">有/應有</th>
                  {months.map((m) => (
                    <th key={m} className="w-[26px] px-0 py-2 text-center font-mono text-[10px] font-normal text-muted-foreground">
                      {m.endsWith("-01") || m === months[0] ? <div className="text-foreground">{m.slice(2, 4)}</div> : <div>&nbsp;</div>}
                      {Number(m.slice(5))}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => {
                  const byMonth = new Map(s.months.map((c) => [c.month, c]));
                  return (
                    <tr key={s.id} className="border-b border-line-2 last:border-0">
                      <td className="sticky left-0 z-10 bg-card px-3 py-1.5">
                        <div className="font-medium">{s.name}</div>
                        <div className="text-[11px] text-muted-foreground">
                          {CADENCE_LABELS[s.cadence]} · {s.startMonth}~{s.endMonth ?? "仍在繳"}
                          {s.ownership && s.ownership !== "pending" ? ` · ${OWNERSHIP_LABELS[s.ownership as OwnershipScope] ?? s.ownership}` : ""}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-right font-mono">
                        {s.summary.present}/{s.summary.expected}
                        {s.summary.missing > 0 && <span className="ml-1 text-destructive">缺{s.summary.missing}</span>}
                      </td>
                      {months.map((m) => {
                        const cell = byMonth.get(m);
                        if (!cell) return <td key={m} className="px-0 py-1.5" />;
                        return (
                          <td key={m} className="px-[2px] py-1.5 text-center">
                            <button
                              type="button"
                              title={`${m} ${COVERAGE_STATUS_LABELS[cell.status]}${cell.expected ? "" : "(非應有月份)"}`}
                              onClick={() => setSelected({ series: s, cell })}
                              className={`inline-flex h-[22px] w-[22px] items-center justify-center border text-[10px] ${STATUS_CLASS[cell.status]} ${
                                cell.expected ? "" : "border-dashed opacity-70"
                              }`}
                            >
                              {STATUS_GLYPH[cell.status]}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <CellDrawer
        selected={selected}
        onClose={() => setSelected(null)}
        onChanged={() => {
          setSelected(null);
          load();
        }}
      />
    </AppShell>
  );
}

function CellDrawer({
  selected,
  onClose,
  onChanged,
}: {
  selected: { series: CoverageSeries; cell: CoverageCell } | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setNote(selected?.cell.note ?? "");
    setError(null);
  }, [selected]);

  async function mark(status: "not_required" | "encrypted" | null) {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/recurring/series/${selected.series.id}/marks`, {
        method: "POST",
        body: JSON.stringify({ month: selected.cell.month, status, note: note || null }),
      });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const cell = selected?.cell;
  const hasDocs = !!cell && (cell.documentIds.length > 0 || cell.reminderDocumentIds.length > 0);
  const markable = !!cell && !hasDocs;

  return (
    <Drawer open={!!selected} onClose={onClose} title={selected ? `${selected.series.name} · ${selected.cell.month}` : ""}>
      {selected && cell && (
        <div className="space-y-4 text-sm">
          <div className="flex items-center gap-2">
            <span className={`inline-flex items-center border px-2 py-0.5 text-xs ${STATUS_CLASS[cell.status]}`}>{COVERAGE_STATUS_LABELS[cell.status]}</span>
            {!cell.expected && <span className="text-xs text-muted-foreground">不在這個帳單的應有月份內</span>}
          </div>

          {cell.documentIds.length > 0 && (
            <div>
              <div className="mb-1 text-xs text-muted-foreground">帳單/繳款單</div>
              <DocList ids={cell.documentIds} />
            </div>
          )}
          {cell.reminderDocumentIds.length > 0 && (
            <div>
              <div className="mb-1 text-xs text-muted-foreground">催繳/滯納/行政執行</div>
              <DocList ids={cell.reminderDocumentIds} />
            </div>
          )}

          {markable && (
            <div className="border-t border-line-2 pt-3">
              <div className="mb-2 text-xs text-muted-foreground">這個月沒有文件。可以標記為:</div>
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="備註(選填),例如:當月無消費" className="mb-2 h-8 text-xs" />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" disabled={busy} onClick={() => mark("not_required")}>
                  無需帳單
                </Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => mark("encrypted")}>
                  只有加密檔
                </Button>
                {(cell.status === "not_required" || cell.status === "encrypted") && (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => mark(null)}>
                    取消標記
                  </Button>
                )}
              </div>
            </div>
          )}
          {error && <div className="text-xs text-destructive">{error}</div>}
        </div>
      )}
    </Drawer>
  );
}

function DocList({ ids }: { ids: string[] }) {
  return (
    <ul className="space-y-1">
      {ids.map((id) => (
        <li key={id}>
          <Link href={`/documents?view=document&id=${id}`} className="font-mono text-xs text-primary hover:underline">
            {id}
          </Link>
        </li>
      ))}
    </ul>
  );
}

export default function RecurringPage() {
  return (
    <Suspense fallback={null}>
      <RecurringRoot />
    </Suspense>
  );
}
