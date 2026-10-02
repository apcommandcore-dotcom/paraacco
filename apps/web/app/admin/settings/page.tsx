"use client";

// 系統設定(2026-09-07 補完設計落差任務書任務 1 先留入口)。
//
// 2026-09-29(CODE_TASK_purchase-object-merge-docs_20260929_V1.01.md 5.3):第一個實際的設定——混合歸屬警告截止日
// (app_settings.mixed_ownership_cutoff,預設 2026-10-01)。開立日在這天(含)之後的發票被設成混合歸屬時,
// 覆核頁警告「專案/公司使用應單獨開發票」(仍可儲存),並列入月報表「待確認」。截止日前的發票不警告。

import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { AdminNav } from "@/components/admin-nav";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";

export default function AdminSettingsPage() {
  const [cutoff, setCutoff] = useState("");
  const [saved, setSaved] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 2026-10-01 定期繳費帳單未到寬限天數(CODE_TASK_recurring-bills-single-page_20260929_V1.04.md 七.2)
  const [grace, setGrace] = useState("");
  const [savedGrace, setSavedGrace] = useState("");
  const [graceMessage, setGraceMessage] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ settings: Record<string, string> }>("/api/settings")
      .then((d) => {
        setCutoff(d.settings.mixed_ownership_cutoff ?? "");
        setSaved(d.settings.mixed_ownership_cutoff ?? "");
        setGrace(d.settings.recurring_bill_grace_days ?? "");
        setSavedGrace(d.settings.recurring_bill_grace_days ?? "");
      })
      .catch((err) => setMessage(err instanceof Error ? err.message : String(err)));
  }, []);

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      await apiFetch("/api/settings/mixed_ownership_cutoff", { method: "POST", body: JSON.stringify({ value: cutoff }) });
      setSaved(cutoff);
      setMessage("已儲存");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveGrace() {
    setBusy(true);
    setGraceMessage(null);
    try {
      await apiFetch("/api/settings/recurring_bill_grace_days", { method: "POST", body: JSON.stringify({ value: grace }) });
      setSavedGrace(grace);
      setGraceMessage("已儲存");
    } catch (err) {
      setGraceMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell>
      <h1 className="mb-4 text-xl font-semibold tracking-wide">管理 — 系統設定</h1>
      <AdminNav />
      <Card>
        <CardHeader>
          <CardTitle>混合歸屬警告截止日</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            過去的發票可能是公私混合購買,可以逐項改品項歸屬;之後凡專案或公司使用都會單獨開發票。開立日在這天(含)之後的發票如果被設成混合歸屬,
            覆核頁會警告「專案/公司使用應單獨開發票」(仍可儲存),並列入月報表的「待確認」。
          </p>
          <div className="flex items-end gap-2">
            <label>
              <span className="mb-1 block text-xs text-muted-foreground">截止日</span>
              <Input type="date" value={cutoff} onChange={(e) => setCutoff(e.target.value)} className="w-44" />
            </label>
            <Button size="sm" disabled={busy || !cutoff || cutoff === saved} onClick={save}>
              儲存
            </Button>
            {message && <span className="text-xs text-muted-foreground">{message}</span>}
          </div>
        </CardContent>
      </Card>
      <Card className="mt-4">
        <CardHeader>
          <CardTitle>定期繳費:帳單未到寬限天數</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-muted-foreground">預期帳單日之後超過這個天數還沒有帳單文件,期次才顯示「帳單未到」並推播提醒。預設 30 天。</p>
          <div className="flex items-end gap-2">
            <label>
              <span className="mb-1 block text-xs text-muted-foreground">天數</span>
              <Input type="number" min={0} max={180} value={grace} onChange={(e) => setGrace(e.target.value)} className="w-28" />
            </label>
            <Button size="sm" disabled={busy || grace === "" || grace === savedGrace} onClick={saveGrace}>
              儲存
            </Button>
            {graceMessage && <span className="text-xs text-muted-foreground">{graceMessage}</span>}
          </div>
        </CardContent>
      </Card>
    </AppShell>
  );
}
