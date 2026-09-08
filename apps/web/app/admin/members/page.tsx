"use client";

import { AppShell } from "@/components/app-shell";
import { AdminNav } from "@/components/admin-nav";
import { MembersTab } from "../admin-tabs";

export default function AdminMembersPage() {
  return (
    <AppShell>
      <h1 className="mb-4 text-xl font-semibold tracking-wide">管理 — 公司與成員</h1>
      <AdminNav />
      <MembersTab />
    </AppShell>
  );
}
