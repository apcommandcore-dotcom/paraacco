"use client";

// 覆核頁「定期帳單」欄位(2026-09-28,CODE_TASK_local-originals-nas-path_20260927_V1.01.md 第六節 5)——
// billing_month(可多個月,雙月帳單填兩個)、recurring_series、專案代碼。系統建議由
// GET /api/recurring/documents/:id 算好(依 match_rule 與發票期別/單據日期),人工按「確認」才寫入
// (寫入的欄位標 isUserConfirmed,之後重跑判讀不會覆蓋)。
// 2026-09-29(CODE_TASK_recurring-bills-single-page_20260929_V1.01.md 2.4):確認帶到 series 的文件就歸到「定期繳費」
// (/recurring),處理中心/總覽/依標題瀏覽預設不再列出;文字從「定期帳單」改成「定期繳費」。

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiFetch, REVIEW_REASON_LABELS, type ProjectRow, type RecurringDocumentInfo, type RecurringReview, type RecurringSeriesRow } from "@/lib/api";

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function parseMonths(text: string): string[] | null {
  const parts = text
    .split(/[\s,、]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.every((p) => MONTH_RE.test(p)) ? [...new Set(parts)].sort() : null;
}

export function RecurringFields({ documentId, projects, onSaved }: { documentId: string; projects: ProjectRow[]; onSaved?: () => void }) {
  const [info, setInfo] = useState<RecurringDocumentInfo | null>(null);
  const [series, setSeries] = useState<RecurringSeriesRow[]>([]);
  const [monthsText, setMonthsText] = useState("");
  const [seriesId, setSeriesId] = useState("");
  const [projectCode, setProjectCode] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // 2026-10-01(V1.04 3.1):自動掛期的待覆核(中信心、重複帳單、統編未建檔)——一鍵確認掛上。
  const [reviews, setReviews] = useState<RecurringReview[]>([]);
  const loadReviews = () =>
    apiFetch<{ reviews: RecurringReview[] }>(`/api/recurring/reviews?documentId=${documentId}`)
      .then((d) => setReviews(d.reviews))
      .catch(() => setReviews([]));

  useEffect(() => {
    apiFetch<{ series: RecurringSeriesRow[] }>("/api/recurring/series")
      .then((d) => setSeries(d.series))
      .catch(() => setSeries([]));
  }, []);

  useEffect(() => {
    setInfo(null);
    setMessage(null);
    apiFetch<RecurringDocumentInfo>(`/api/recurring/documents/${documentId}`)
      .then((d) => {
        setInfo(d);
        setMonthsText(d.billingMonths.join(", "));
        setSeriesId(d.recurringSeriesId ?? "");
        setProjectCode(d.projectCode ?? "");
      })
      .catch((err) => setMessage(err instanceof Error ? err.message : String(err)));
    loadReviews();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId]);

  const months = parseMonths(monthsText);
  const suggestedSeries = info?.suggestion.series ? series.find((s) => s.id === info.suggestion.series!.seriesId) : null;
  const hasSuggestion = !!info && (info.suggestion.billingMonths.length > 0 || !!suggestedSeries);

  function applySuggestion() {
    if (!info) return;
    if (info.suggestion.billingMonths.length) setMonthsText(info.suggestion.billingMonths.join(", "));
    if (info.suggestion.series) setSeriesId(info.suggestion.series.seriesId);
  }

  async function save() {
    if (months === null) return;
    setSaving(true);
    setMessage(null);
    try {
      await apiFetch(`/api/recurring/documents/${documentId}`, {
        method: "POST",
        body: JSON.stringify({ billingMonths: months, recurringSeriesId: seriesId || null, projectCode: projectCode || null }),
      });
      const refreshed = await apiFetch<RecurringDocumentInfo>(`/api/recurring/documents/${documentId}`);
      setInfo(refreshed);
      setMessage("已確認");
      onSaved?.();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mb-4 border border-border p-3 text-sm">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">定期繳費/專案</div>
        {info && (info.billingMonthsConfirmed || info.recurringSeriesConfirmed) && <span className="text-xs text-ok">已人工確認</span>}
      </div>

      {reviews.map((r) => (
        <div key={r.id} className="mb-2.5 flex items-center justify-between gap-2 border border-warning-line bg-warning-bg px-2 py-1.5 text-xs">
          <span className="text-warning">
            自動掛期待確認({REVIEW_REASON_LABELS[r.reason] ?? r.reason}):{series.find((x) => x.id === r.seriesId)?.name ?? r.seriesId ?? "—"} {r.periodKey ?? ""}
            {r.note ? ` · ${r.note}` : ""}
          </span>
          <span className="flex flex-none gap-2">
            {r.seriesId && r.periodKey && (
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() => apiFetch(`/api/recurring/reviews/${r.id}/accept`, { method: "POST", body: "{}" }).then(() => { loadReviews(); onSaved?.(); }).catch((err) => setMessage(String(err)))}
              >
                確認掛上
              </button>
            )}
            <button
              type="button"
              className="text-foreground-3 hover:underline"
              onClick={() => apiFetch(`/api/recurring/reviews/${r.id}/reject`, { method: "POST", body: "{}" }).then(loadReviews).catch((err) => setMessage(String(err)))}
            >
              不是
            </button>
          </span>
        </div>
      ))}

      {hasSuggestion && (
        <div className="mb-2.5 flex items-center justify-between gap-2 border border-info-line bg-info-bg px-2 py-1.5 text-xs">
          <span className="text-info">
            系統建議:{suggestedSeries?.name ?? "—"}
            {info!.suggestion.billingMonths.length ? ` · ${info!.suggestion.billingMonths.join("、")}` : ""}
          </span>
          <button type="button" onClick={applySuggestion} className="flex-none text-primary hover:underline">
            套用
          </button>
        </div>
      )}

      <div className="space-y-2">
        <label className="block">
          <span className="mb-1 block text-xs text-muted-foreground">定期繳費項目(確認後歸到「定期繳費」頁,一般列表預設不顯示)</span>
          <select
            value={seriesId}
            onChange={(e) => setSeriesId(e.target.value)}
            className="h-8 w-full border border-input bg-background px-2 text-xs"
          >
            <option value="">(不是定期繳費)</option>
            {series.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-muted-foreground">帳單月份(YYYY-MM,雙月帳單填兩個,用逗號分隔)</span>
          <Input
            value={monthsText}
            onChange={(e) => setMonthsText(e.target.value)}
            placeholder="2026-07, 2026-08"
            className="h-8 text-xs"
            aria-invalid={months === null}
          />
          {months === null && <span className="mt-1 block text-xs text-destructive">月份格式要是 YYYY-MM</span>}
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-muted-foreground">專案代碼(只做標記,不影響 NAS 路徑)</span>
          <select
            value={projectCode}
            onChange={(e) => setProjectCode(e.target.value)}
            className="h-8 w-full border border-input bg-background px-2 text-xs"
          >
            <option value="">(無)</option>
            {projectCode && !projects.some((p) => p.id === projectCode) && <option value={projectCode}>{projectCode}</option>}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id} {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="mt-3 flex items-center justify-end gap-2">
        {message && <span className="text-xs text-muted-foreground">{message}</span>}
        <Button size="sm" variant="outline" disabled={saving || !info || months === null} onClick={save}>
          確認
        </Button>
      </div>
    </div>
  );
}
