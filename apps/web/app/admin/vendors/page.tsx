"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { AdminNav } from "@/components/admin-nav";
import { VendorsTab, CategoriesTab } from "../admin-tabs";

// ?taxId=…:從處理中心「待建檔供應商」點統編過來時自動帶入(2026-09-29)。
function VendorsContent() {
  const taxId = useSearchParams().get("taxId");
  return (
    <div className="flex flex-col gap-4">
      <VendorsTab key={taxId ?? ""} initialTaxId={taxId} />
      <CategoriesTab />
    </div>
  );
}

export default function AdminVendorsPage() {
  return (
    <AppShell>
      <h1 className="mb-4 text-xl font-semibold tracking-wide">管理 — 供應商與分類</h1>
      <AdminNav />
      <Suspense fallback={null}>
        <VendorsContent />
      </Suspense>
    </AppShell>
  );
}
