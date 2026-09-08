"use client";

// /admin 本身沒有內容——2026-09-07 補完設計落差任務書任務 1 把管理後台拆成 5 個獨立畫面
// (見 ./members、./vendors、./rules、./transfers、./settings),這裡只是進站預設落點,
// 導到「供應商與分類」(舊版單頁分頁時的預設第一分頁)。

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function AdminRedirectPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/admin/vendors");
  }, [router]);
  return null;
}
