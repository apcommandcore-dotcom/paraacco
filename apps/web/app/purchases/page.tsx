"use client";

// 購買案獨立頂層導覽項目(2026-09-07 補完設計落差任務書任務 1)—— 底層沿用既有的
// /documents?view=purchase 畫面邏輯(PurchasesView,見 app/documents/page.tsx),不重寫,
// 只是換一個側邊欄看得到的獨立入口。用 client-side redirect 而不是把 PurchasesView 整個
// 搬過來,避免同一份邏輯出現兩份分岔——代價是網址列最後會落在 /documents?view=purchase,
// 不是常駐的 /purchases,這點記錄在報告裡。

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function PurchasesRedirectPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/documents?view=purchase");
  }, [router]);
  return null;
}
