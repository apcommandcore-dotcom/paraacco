"use client";

import { AppShell } from "@/components/app-shell";
import { AdminNav } from "@/components/admin-nav";
import { TransfersTab } from "../admin-tabs";

export default function AdminTransfersPage() {
  return (
    <AppShell>
      <h1 className="mb-4 text-xl font-semibold tracking-wide">管理 — 歸屬移轉與稽核</h1>
      <AdminNav />
      <TransfersTab />
    </AppShell>
  );
}
