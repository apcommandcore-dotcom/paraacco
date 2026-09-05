"use client";

// 全域搜尋結果頁(規格 3.6)—— 接 GET /api/search,真正的 FTS5 全文檢索(供應商名稱、
// 發票/訂單/序號、OCR 擷取欄位的值、原始檔名都會比對到),不是只篩選文件編號/供應商/發票
// 號碼這幾個直欄。已知還缺:排序權重調整、片段 highlight 樣式(目前 snippet 是後端
// sqlite FTS5 snippet() 產生的純文字,已經有 [] 包住命中詞,先直接顯示文字就好)。

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Search as SearchIcon } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { apiFetch, DOC_STATUS_LABELS, type DocumentRow } from "@/lib/api";

interface SearchResult {
  document: DocumentRow;
  snippet: string;
}

function SearchResults() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const q = searchParams.get("q") ?? "";

  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!q.trim()) {
      setResults([]);
      return;
    }
    setResults(null);
    apiFetch<{ results: SearchResult[] }>(`/api/search?q=${encodeURIComponent(q)}`)
      .then((d) => setResults(d.results))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [q]);

  return (
    <AppShell>
      <div className="mb-6 flex items-center gap-2">
        <SearchIcon size={18} className="text-muted-foreground" />
        <h1 className="text-xl font-semibold tracking-wide">搜尋:{q}</h1>
      </div>

      {error && <div className="mb-4 border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}

      {results === null && <p className="text-sm text-muted-foreground">搜尋中…</p>}
      {results?.length === 0 && q.trim() && <p className="text-sm text-muted-foreground">沒有找到符合的文件。</p>}

      <div className="space-y-3">
        {results?.map((r) => (
          <Card key={r.document.id} className="cursor-pointer hover:bg-accent" onClick={() => router.push(`/documents?view=document&id=${r.document.id}`)}>
            <CardContent className="p-4">
              <div className="mb-1 flex items-center justify-between">
                <span className="font-mono text-xs text-muted-foreground">{r.document.id}</span>
                <Badge>{DOC_STATUS_LABELS[r.document.status] ?? r.document.status}</Badge>
              </div>
              <div className="mb-1 text-sm">{r.document.vendorNameRaw ?? "（未擷取供應商）"}</div>
              <div className="text-xs text-muted-foreground" dangerouslySetInnerHTML={{ __html: escapeExceptBrackets(r.snippet) }} />
            </CardContent>
          </Card>
        ))}
      </div>
    </AppShell>
  );
}

// snippet() 用 '[' ']' 當命中詞的標記字元(見 packages/db/src/search.ts 的
// searchDocumentFts),這裡把中括號換成 <mark> 讓命中詞有底色,其餘文字照常escape避免
// XSS(snippet 內容來自 OCR 擷取欄位/檔名,理論上是純文字,但還是不要直接信任)。
function escapeExceptBrackets(text: string): string {
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return escaped.replace(/\[/g, "<mark>").replace(/\]/g, "</mark>");
}

export default function SearchPage() {
  return (
    <Suspense fallback={null}>
      <SearchResults />
    </Suspense>
  );
}
