"use client";

// 覆核頁「合併到物件」(2026-09-29,CODE_TASK_purchase-object-merge-docs_20260929_V1.01.md 2.2、第三節)——
// - 系統建議的候選(規則 1–5,由強到弱):一鍵合併;規則 1(同一發票號碼)是重複檔,走標示重複,不當附件。
// - 手動搜尋其他物件(發票號、金額、供應商),指定角色後加入。
// - 這份文件已屬於物件時:顯示所屬物件、角色,可移出(恢復成獨立文件)。
// 歸屬衝突時以主文件(發票)為準,這裡顯示警告讓 Theo 確認。

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatCents } from "@/lib/format";
import {
  apiFetch,
  ATTACHMENT_ROLE_LABELS,
  DOC_KIND_LABELS,
  MERGE_RULE_LABELS,
  OWNERSHIP_LABELS,
  type MergeCandidatesResponse,
  type ObjectDetail,
  type OwnershipScope,
  type PurchaseRow,
} from "@/lib/api";

const nt = (cents: number | null | undefined) => formatCents(cents);

export function MergeToObject({ documentId, onChanged }: { documentId: string; onChanged?: () => void }) {
  const [data, setData] = useState<MergeCandidatesResponse | null>(null);
  const [object, setObject] = useState<ObjectDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [purchases, setPurchases] = useState<PurchaseRow[] | null>(null);
  const [query, setQuery] = useState("");
  const [role, setRole] = useState("");

  const load = useCallback(() => {
    setError(null);
    apiFetch<MergeCandidatesResponse>(`/api/purchases/merge-candidates?documentId=${documentId}`)
      .then((d) => {
        setData(d);
        if (d.currentPurchaseId) {
          apiFetch<{ object: ObjectDetail | null }>(`/api/purchases/${d.currentPurchaseId}`)
            .then((o) => setObject(o.object))
            .catch(() => setObject(null));
        } else setObject(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [documentId]);
  useEffect(load, [load]);

  async function run(path: string, body: unknown, confirmText?: string) {
    if (confirmText && !confirm(confirmText)) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(path, { method: "POST", body: JSON.stringify(body) });
      load();
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/[-\s]/g, "");
    if (!purchases || !q) return [];
    return purchases
      .filter(
        (p) =>
          p.id.toLowerCase().includes(q) ||
          (p.invoiceNo ?? "").toLowerCase().replace(/[-\s]/g, "").includes(q) ||
          p.vendorNameRaw.toLowerCase().includes(q) ||
          String(Math.round(p.amountCents / 100)) === q,
      )
      .slice(0, 15);
  }, [purchases, query]);

  const self = object?.documents.find((d) => d.documentId === documentId);

  return (
    <Card className="h-fit">
      <CardHeader>
        <CardTitle>合併到物件</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        {error && <div className="border border-destructive-line bg-destructive-bg p-2 text-destructive">{error}</div>}
        {!data && !error && <p className="text-muted-foreground">載入中…</p>}

        {data?.currentPurchaseId && (
          <div className="border border-info-line bg-info-bg p-2">
            <div>
              已屬於物件{" "}
              <Link href={`/documents?view=purchase&id=${data.currentPurchaseId}`} className="font-mono text-primary hover:underline">
                {data.currentPurchaseId}
              </Link>
              {self && (
                <span className="ml-1">
                  ・{self.relationKind === "primary" ? "主文件" : `附件(${ATTACHMENT_ROLE_LABELS[self.attachmentRole ?? "OTHER"]})`}
                </span>
              )}
            </div>
            {object && (
              <div className="mt-1 text-foreground-2">
                主文件 {object.primary?.documentId} {nt(object.primary?.amountCents)}・附件 {object.documents.length - 1}・品項 {object.items.length}
                {object.flags.itemAmountMismatch && <Badge variant="warning" className="ml-1">品項金額不符</Badge>}
              </div>
            )}
            {object?.flags.mixedOwnershipWarning && (
              <div className="mt-1 flex items-center gap-1 text-destructive">
                <AlertTriangle size={12} />
                {object.flags.cutoff} 之後的發票設成混合歸屬:專案/公司使用應單獨開發票(已列入月報表待確認)
              </div>
            )}
            {object?.flags.ownershipConflicts.includes(documentId) && (
              <div className="mt-1 flex items-center gap-1 text-warning">
                <AlertTriangle size={12} />
                這份文件的歸屬跟主文件不同,物件以主文件歸屬為準
              </div>
            )}
            <button
              type="button"
              disabled={busy}
              className="mt-1 text-destructive hover:underline"
              onClick={() => run(`/api/purchases/${data.currentPurchaseId}/documents/${documentId}/remove`, {}, "從物件移出這份文件?它會恢復成獨立文件。")}
            >
              從物件移出
            </button>
          </div>
        )}

        {data && data.candidates.length > 0 && (
          <div className="space-y-2">
            <div className="font-semibold uppercase tracking-widest text-muted-foreground">系統建議</div>
            {data.candidates.map((c) => (
              <div key={c.documentId} className="border border-border p-2">
                <div className="mb-1 flex items-center justify-between gap-1">
                  <Link href={`/review?doc=${c.documentId}`} className="font-mono text-primary hover:underline">
                    {c.documentId}
                  </Link>
                  <Badge variant={c.rule <= 2 ? "success" : c.uncertain ? "warning" : "outline"}>規則 {c.rule}</Badge>
                </div>
                <div className="text-foreground-2">
                  {DOC_KIND_LABELS[c.otherKind] ?? c.otherKind}・{c.otherDate ?? "—"}・{c.otherVendorName ?? "—"}・{nt(c.otherAmountCents)}・
                  {OWNERSHIP_LABELS[c.otherOwnership] ?? c.otherOwnership}
                  {c.purchaseId && <span className="ml-1 font-mono">(物件 {c.purchaseId})</span>}
                </div>
                <div className="mt-0.5 text-foreground-3">{MERGE_RULE_LABELS[c.rule]}:{c.note}</div>
                {c.ownershipConflict && !c.duplicate && (
                  <div className="mt-0.5 flex items-center gap-1 text-warning">
                    <AlertTriangle size={11} />
                    歸屬不同,合併後以主文件(發票)歸屬為準
                  </div>
                )}
                <div className="mt-1.5">
                  {c.duplicate ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full"
                      disabled={busy}
                      onClick={() => run(`/api/documents/${documentId}/status`, { status: "dup", note: `與 ${c.documentId} 發票號碼相同(${c.note}),標為重複檔` }, `把 ${documentId} 標為 ${c.documentId} 的重複檔?`)}
                    >
                      同一張發票:標示這份為重複檔
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      className="w-full"
                      disabled={busy || (!!data.currentPurchaseId && data.currentPurchaseId === c.purchaseId)}
                      onClick={() =>
                        run("/api/purchases/merge", {
                          documentIds: [documentId, c.documentId],
                          primaryDocumentId: c.suggestedRole === "primary" ? documentId : undefined,
                          itemLineNos: c.itemLineNo ? { [documentId]: c.itemLineNo } : undefined,
                        })
                      }
                    >
                      合併({c.suggestedRole === "primary" ? "這份當主文件" : `這份當${ATTACHMENT_ROLE_LABELS[c.suggestedRole] ?? "附件"}`})
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        {data && data.candidates.length === 0 && !data.currentPurchaseId && <p className="text-muted-foreground">沒有系統建議的合併對象。</p>}

        {data && !data.currentPurchaseId && (
          <Button size="sm" variant="outline" className="w-full" disabled={busy} onClick={() => run("/api/purchases/merge", { documentIds: [documentId] })}>
            這份單獨建立物件
          </Button>
        )}

        {data && (
          <div className="border-t border-border pt-2">
            <div className="mb-1 font-semibold uppercase tracking-widest text-muted-foreground">手動搜尋物件</div>
            <div className="flex gap-1">
              <Input
                value={query}
                onFocus={() =>
                  purchases === null &&
                  apiFetch<{ purchases: PurchaseRow[] }>("/api/purchases")
                    .then((d) => setPurchases(d.purchases))
                    .catch(() => setPurchases([]))
                }
                onChange={(e) => setQuery(e.target.value)}
                placeholder="發票號/金額(元)/供應商"
                className="h-8 text-xs"
              />
              <select value={role} onChange={(e) => setRole(e.target.value)} className="h-8 border border-input bg-background px-1 text-[11px]" title="加入後的角色">
                <option value="">自動</option>
                <option value="primary">主文件</option>
                {Object.entries(ATTACHMENT_ROLE_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
            <div className="mt-1 max-h-48 space-y-1 overflow-y-auto">
              {matches.map((p) => (
                <div key={p.id} className="flex items-center justify-between gap-1 border border-line-2 p-1.5">
                  <span className="truncate">
                    <span className="font-mono">{p.id}</span>・{p.purchaseDate}・{p.vendorNameRaw}・{nt(p.amountCents)}・{OWNERSHIP_LABELS[p.ownership as OwnershipScope] ?? p.ownership}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || data.currentPurchaseId === p.id}
                    onClick={() => run(`/api/purchases/${p.id}/documents`, { documentId, role: role || null })}
                  >
                    加入
                  </Button>
                </div>
              ))}
              {query && purchases && matches.length === 0 && <p className="text-muted-foreground">沒有符合的物件。</p>}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
