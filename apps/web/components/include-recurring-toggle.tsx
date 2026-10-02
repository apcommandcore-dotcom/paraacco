"use client";

// 「包含定期繳費」切換(2026-09-29,CODE_TASK_recurring-bills-single-page_20260929_V1.01.md 2.4)——
// 掛上 recurring_series 的文件(recurringSeriesId 不為空)是定期繳費帳單,處理中心/總覽/依標題瀏覽預設不顯示,
// 打開才列出。選擇記在瀏覽器(每頁各自記),預設關。

import { useEffect, useState } from "react";

export function useIncludeRecurring(pageKey: string): [boolean, (v: boolean) => void] {
  const storageKey = `paraacco:include-recurring:${pageKey}`;
  const [value, setValue] = useState(false);
  useEffect(() => {
    try {
      setValue(window.localStorage.getItem(storageKey) === "1");
    } catch {
      // 無痕模式等讀不到 localStorage:維持預設關
    }
  }, [storageKey]);
  const set = (v: boolean) => {
    setValue(v);
    try {
      window.localStorage.setItem(storageKey, v ? "1" : "0");
    } catch {
      // 寫不進去就只在這次頁面有效
    }
  };
  return [value, set];
}

export function IncludeRecurringToggle({ value, onChange, hiddenCount }: { value: boolean; onChange: (v: boolean) => void; hiddenCount?: number }) {
  return (
    <label className="flex h-9 items-center gap-1.5 text-sm text-foreground-2" title="定期繳費帳單集中在「定期繳費」頁,這裡預設不列">
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      包含定期繳費
      {!value && hiddenCount ? <span className="font-mono text-[11px] text-foreground-3">(隱藏 {hiddenCount} 份)</span> : null}
    </label>
  );
}
