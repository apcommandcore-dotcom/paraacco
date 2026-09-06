"use client";

// 待覆核工作台(規格 3.5.2)—— Phase 2:三欄式(左:待覆核清單、中:原始檔案+擷取欄位、
// 右:關聯候選+操作)。中欄刻意不做「模擬電子發票證明聯版面重建」的高擬真度視覺,直接顯示
// 原始 PDF/圖片 + 擷取欄位純文字表格,見 CODE_TASK_go-live-a2-a3-phase1_20260904.md Phase 2
// 範圍說明。

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CheckCircle2, XCircle, AlertCircle, Search } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  apiFetch,
  API_BASE,
  type DocumentRow,
  type ExtractedField,
  type DocumentFile,
  type RelationCandidate,
  type PurchaseRow,
  type AssetRow,
} from "@/lib/api";

interface DocumentDetail {
  document: DocumentRow;
  fields: ExtractedField[];
  files: DocumentFile[];
}

function confidenceVariant(confidence: number | null): "success" | "warning" | "destructive" | "outline" {
  if (confidence == null) return "outline";
  if (confidence >= 80) return "success";
  if (confidence >= 40) return "warning";
  return "destructive";
}

function ReviewWorkbench() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedId = searchParams.get("doc");

  const [queue, setQueue] = useState<DocumentRow[] | null>(null);
  const [detail, setDetail] = useState<DocumentDetail | null>(null);
  const [candidates, setCandidates] = useState<RelationCandidate[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 手動搜尋既有採購案/資產來配對——沒有 pipeline 算出來的候選時(或候選都不對)不該卡住,
  // 讓使用者自己找。先求能動:一次抓全部 purchases/assets 在前端篩選,資料量對內部工具來說
  //還小(跟 Dashboard/Reports 頁同樣的作法)。
  const [manualQuery, setManualQuery] = useState("");
  const [purchases, setPurchases] = useState<PurchaseRow[] | null>(null);
  const [assets, setAssets] = useState<AssetRow[] | null>(null);

  const loadQueue = useCallback(async () => {
    try {
      const data = await apiFetch<{ documents: DocumentRow[] }>("/api/documents?status=review");
      setQueue(data.documents);
      if (!selectedId && data.documents.length > 0) {
        router.replace(`/review?doc=${data.documents[0].id}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadQueue();
  }, [loadQueue]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setCandidates(null);
      return;
    }
    setDetail(null);
    setCandidates(null);
    setManualQuery("");
    apiFetch<DocumentDetail>(`/api/documents/${selectedId}`)
      .then(setDetail)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    apiFetch<{ candidates: RelationCandidate[] }>(`/api/documents/${selectedId}/candidates`)
      .then((d) => setCandidates(d.candidates))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [selectedId]);

  // 手動搜尋清單只在第一次真的需要時才抓(候選都用完、或使用者主動要找),不用每次選文件
  // 都重抓一次全部採購案/資產。
  function loadManualSearchData() {
    if (purchases === null) {
      apiFetch<{ purchases: PurchaseRow[] }>("/api/purchases")
        .then((d) => setPurchases(d.purchases))
        .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    }
    if (assets === null) {
      apiFetch<{ assets: AssetRow[] }>("/api/assets")
        .then((d) => setAssets(d.assets))
        .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    }
  }

  async function refreshAfterAction() {
    await loadQueue();
    router.replace("/review");
  }

  async function linkCandidate(candidate: RelationCandidate) {
    if (!selectedId) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/documents/${selectedId}/link`, {
        method: "POST",
        body: JSON.stringify({ targetType: candidate.targetType, targetId: candidate.targetId, candidateId: candidate.id }),
      });
      await refreshAfterAction();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function linkManual(targetType: "purchase" | "asset", targetId: string) {
    if (!selectedId) return;
    setBusy(true);
    setError(null);
    try {
      // 手動配對沒有 candidateId——POST /:id/link 本來就把它設計成可選,不帶的話只會連結
      // 這一筆,不會動到其他 pending 候選的狀態。
      await apiFetch(`/api/documents/${selectedId}/link`, {
        method: "POST",
        body: JSON.stringify({ targetType, targetId }),
      });
      await refreshAfterAction();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function markStatus(status: "dup" | "ignored" | "failed") {
    if (!selectedId) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/documents/${selectedId}/status`, { method: "POST", body: JSON.stringify({ status }) });
      await refreshAfterAction();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const originalFile = detail?.files.find((f) => f.kind === "original" && f.isCurrent);

  return (
    <AppShell>
      <h1 className="mb-6 text-xl font-semibold tracking-wide">待覆核工作台</h1>
      {error && (
        <div className="mb-4 flex items-center gap-2 border border-destructive-line bg-destructive-bg p-3 text-sm text-destructive">
          <AlertCircle size={14} />
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_1fr_320px]">
        {/* 左欄:待覆核清單 */}
        <Card className="h-fit">
          <CardHeader>
            <CardTitle>待覆核({queue?.length ?? "…"}）</CardTitle>
          </CardHeader>
          <CardContent className="max-h-[70vh] overflow-y-auto p-0">
            {queue === null && <div className="p-4 text-sm text-muted-foreground">載入中…</div>}
            {queue?.length === 0 && <div className="p-4 text-sm text-muted-foreground">目前沒有待覆核文件。</div>}
            <ul>
              {queue?.map((doc) => (
                <li key={doc.id}>
                  <button
                    onClick={() => router.push(`/review?doc=${doc.id}`)}
                    className={`w-full border-b border-border p-3 text-left text-xs hover:bg-accent ${
                      doc.id === selectedId ? "bg-accent" : ""
                    }`}
                  >
                    <div className="font-mono text-muted-foreground">{doc.id}</div>
                    <div className="mt-1 truncate">{doc.vendorNameRaw ?? "（未擷取供應商）"}</div>
                  </button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        {/* 中欄:原始檔案 + 擷取欄位 */}
        <Card className="h-fit">
          {!detail && <CardContent className="p-6 text-sm text-muted-foreground">選一份文件開始覆核。</CardContent>}
          {detail && (
            <>
              <CardHeader>
                <CardTitle>{detail.document.id}</CardTitle>
              </CardHeader>
              <CardContent>
                {originalFile && (
                  <div className="mb-4 border border-border">
                    {originalFile.mimeType.startsWith("image/") ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={`${API_BASE}/api/documents/${detail.document.id}/file`}
                        alt={originalFile.originalFileName}
                        className="max-h-[420px] w-full object-contain"
                      />
                    ) : (
                      <iframe
                        src={`${API_BASE}/api/documents/${detail.document.id}/file`}
                        title={originalFile.originalFileName}
                        className="h-[420px] w-full"
                      />
                    )}
                  </div>
                )}

                <table className="w-full text-sm">
                  <tbody>
                    {detail.fields.map((f) => (
                      <tr key={f.id} className="border-b border-border last:border-0">
                        <td className="w-1/3 py-2 pr-3 text-xs text-muted-foreground">{f.label}</td>
                        <td className="py-2 pr-3">{f.value ?? "—"}</td>
                        <td className="w-24 py-2 text-right">
                          {f.confidence != null && <Badge variant={confidenceVariant(f.confidence)}>{f.confidence}</Badge>}
                        </td>
                      </tr>
                    ))}
                    {detail.fields.length === 0 && (
                      <tr>
                        <td className="py-4 text-sm text-muted-foreground">沒有擷取到欄位。</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </CardContent>
            </>
          )}
        </Card>

        {/* 右欄:關聯候選 + 操作 */}
        <Card className="h-fit">
          <CardHeader>
            <CardTitle>關聯候選</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {!detail && <p className="text-sm text-muted-foreground">—</p>}
            {detail && candidates === null && <p className="text-sm text-muted-foreground">載入中…</p>}
            {detail && candidates?.length === 0 && <p className="text-sm text-muted-foreground">沒有找到候選物件。</p>}
            {candidates?.map((cand) => (
              <div key={cand.id} className="border border-border p-3">
                <div className="mb-1 flex items-center justify-between">
                  <span className="font-mono text-xs text-muted-foreground">
                    {cand.targetType === "purchase" ? "採購案" : "資產"} {cand.targetId}
                  </span>
                  <Badge variant={cand.score >= 80 ? "success" : "outline"}>{cand.score}</Badge>
                </div>
                <ul className="mb-2 list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
                  {cand.reasons.map((reason, i) => (
                    <li key={i}>
                      {reason.label}
                      <span className="ml-1 font-mono">+{reason.points}</span>
                    </li>
                  ))}
                </ul>
                <Button size="sm" className="w-full" disabled={busy} onClick={() => linkCandidate(cand)}>
                  <CheckCircle2 size={14} className="mr-1" />
                  確認並歸檔
                </Button>
              </div>
            ))}

            {detail && (
              <div className="border-t border-border pt-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">手動搜尋配對</span>
                  {purchases === null && assets === null && (
                    <Button variant="ghost" size="sm" onClick={loadManualSearchData}>
                      <Search size={12} className="mr-1" />
                      載入清單
                    </Button>
                  )}
                </div>
                {(purchases !== null || assets !== null) && (
                  <>
                    <Input
                      value={manualQuery}
                      onChange={(e) => setManualQuery(e.target.value)}
                      placeholder="搜尋採購案/資產…"
                      className="mb-2"
                    />
                    <div className="max-h-48 space-y-1 overflow-y-auto">
                      {manualMatches(purchases, assets, manualQuery).map((m) => (
                        <div key={`${m.targetType}-${m.targetId}`} className="flex items-center justify-between border border-border p-2 text-xs">
                          <span className="truncate">
                            {m.targetType === "purchase" ? "採購案" : "資產"} {m.targetId}・{m.label}
                          </span>
                          <Button size="sm" variant="outline" disabled={busy} onClick={() => linkManual(m.targetType, m.targetId)}>
                            連結
                          </Button>
                        </div>
                      ))}
                      {manualQuery && manualMatches(purchases, assets, manualQuery).length === 0 && (
                        <p className="text-xs text-muted-foreground">沒有符合的結果。</p>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}

            {detail && (
              <div className="space-y-2 border-t border-border pt-3">
                <Button variant="outline" size="sm" className="w-full" disabled={busy} onClick={() => markStatus("dup")}>
                  標示重複
                </Button>
                <Button variant="outline" size="sm" className="w-full" disabled={busy} onClick={() => markStatus("ignored")}>
                  略過
                </Button>
                <Button variant="destructive" size="sm" className="w-full" disabled={busy} onClick={() => markStatus("failed")}>
                  <XCircle size={14} className="mr-1" />
                  標示失敗
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}

function manualMatches(
  purchases: PurchaseRow[] | null,
  assets: AssetRow[] | null,
  query: string,
): Array<{ targetType: "purchase" | "asset"; targetId: string; label: string }> {
  const q = query.trim().toLowerCase();
  const purchaseMatches = (purchases ?? [])
    .filter((p) => !q || p.id.toLowerCase().includes(q) || p.vendorNameRaw.toLowerCase().includes(q) || p.summary.toLowerCase().includes(q))
    .slice(0, 20)
    .map((p) => ({ targetType: "purchase" as const, targetId: p.id, label: `${p.vendorNameRaw}・${p.summary}` }));
  const assetMatches = (assets ?? [])
    .filter(
      (a) =>
        !q ||
        a.id.toLowerCase().includes(q) ||
        a.name.toLowerCase().includes(q) ||
        (a.serialNo ?? "").toLowerCase().includes(q) ||
        (a.model ?? "").toLowerCase().includes(q),
    )
    .slice(0, 20)
    .map((a) => ({ targetType: "asset" as const, targetId: a.id, label: a.name }));
  return [...purchaseMatches, ...assetMatches];
}

export default function ReviewPage() {
  return (
    <Suspense fallback={null}>
      <ReviewWorkbench />
    </Suspense>
  );
}
