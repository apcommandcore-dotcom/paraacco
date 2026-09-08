"use client";

// 資產獨立頂層導覽項目(2026-09-07 補完設計落差任務書任務 1)—— 見 app/purchases/page.tsx
// 開頭註解,同樣的做法跟已知取捨。

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function AssetsRedirectPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/documents?view=asset");
  }, [router]);
  return null;
}
