"use client";

// 物件列的展開/收合(2026-09-29,CODE_TASK_purchase-object-merge-docs_20260929_V1.01.md 5.2)——
// 收合:只顯示發票一列;展開:發票列下方縮排列出品項。頁面上方「全部展開/全部收合」,預設收合,
// 使用者的選擇記在瀏覽器(每頁各自記)。個別列也可以單獨展開/收合(不記)。

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

export function useExpandState(pageKey: string) {
  const storageKey = `paraacco:expand-all:${pageKey}`;
  const [allExpanded, setAllExpandedState] = useState(false);
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  useEffect(() => {
    try {
      setAllExpandedState(window.localStorage.getItem(storageKey) === "1");
    } catch {
      // 讀不到 localStorage:維持預設收合
    }
  }, [storageKey]);
  const setAllExpanded = useCallback(
    (v: boolean) => {
      setAllExpandedState(v);
      setOverrides({});
      try {
        window.localStorage.setItem(storageKey, v ? "1" : "0");
      } catch {
        // 寫不進去就只在這次頁面有效
      }
    },
    [storageKey],
  );
  const isExpanded = useCallback((key: string) => overrides[key] ?? allExpanded, [overrides, allExpanded]);
  const toggle = useCallback((key: string) => setOverrides((o) => ({ ...o, [key]: !(o[key] ?? allExpanded) })), [allExpanded]);
  return { allExpanded, setAllExpanded, isExpanded, toggle };
}

export function ExpandAllToggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="inline-flex border border-input text-xs">
      <button type="button" onClick={() => onChange(false)} className={`px-2 py-1.5 ${!value ? "bg-foreground text-background" : "text-foreground-2 hover:bg-muted"}`}>
        全部收合
      </button>
      <button type="button" onClick={() => onChange(true)} className={`border-l border-input px-2 py-1.5 ${value ? "bg-foreground text-background" : "text-foreground-2 hover:bg-muted"}`}>
        全部展開
      </button>
    </div>
  );
}

export function ExpandButton({ expanded, onClick, count }: { expanded: boolean; onClick: (e: React.MouseEvent) => void; count: number }) {
  if (!count) return <span className="inline-block w-4" />;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick(e);
      }}
      className="inline-flex items-center text-foreground-3 hover:text-foreground"
      aria-label={expanded ? "收合品項" : "展開品項"}
      title={expanded ? "收合品項" : `展開 ${count} 個品項`}
    >
      {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
    </button>
  );
}
