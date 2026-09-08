"use client";

import { AppShell } from "@/components/app-shell";
import { AdminNav } from "@/components/admin-nav";
import { VendorsTab, CategoriesTab } from "../admin-tabs";

export default function AdminVendorsPage() {
  return (
    <AppShell>
      <h1 className="mb-4 text-xl font-semibold tracking-wide">管理 — 供應商與分類</h1>
      <AdminNav />
      <div className="flex flex-col gap-4">
        <VendorsTab />
        <CategoriesTab />
      </div>
    </AppShell>
  );
}
