"use client";

// 系統設定(2026-09-07 補完設計落差任務書任務 1)—— 設計稿有這個導覽項目,但系統裡完全
// 沒有「系統設定」這個資料模型(沒有 settings 表、沒有對應 API),比照 OcrRulesTab
// (見 ../admin-tabs.tsx)的做法:不憑空生一套沒人要求過的設定資料表,先留白說明現況。

import { AppShell } from "@/components/app-shell";
import { AdminNav } from "@/components/admin-nav";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function AdminSettingsPage() {
  return (
    <AppShell>
      <h1 className="mb-4 text-xl font-semibold tracking-wide">管理 — 系統設定</h1>
      <AdminNav />
      <Card>
        <CardHeader>
          <CardTitle>系統設定</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          <p>
            目前系統裡沒有「系統設定」這個資料模型——沒有 settings 資料表,也沒有對應的 API。
            這個畫面只是先把導覽入口比照設計稿留出來,實際要存哪些設定值(例如通知排程時間、
            提醒天數預設值、pipeline 相關參數)還沒有定案,需要先確認範圍再實作,不適合在這次
            任務裡臨時決定資料模型。
          </p>
        </CardContent>
      </Card>
    </AppShell>
  );
}
