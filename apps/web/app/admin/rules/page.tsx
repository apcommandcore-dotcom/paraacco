"use client";

import { AppShell } from "@/components/app-shell";
import { AdminNav } from "@/components/admin-nav";
import { OcrRulesTab } from "../admin-tabs";

export default function AdminRulesPage() {
  return (
    <AppShell>
      <h1 className="mb-4 text-xl font-semibold tracking-wide">管理 — 自動化規則</h1>
      <AdminNav />
      <OcrRulesTab />
    </AppShell>
  );
}
