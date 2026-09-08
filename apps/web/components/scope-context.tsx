"use client";

// 範圍切換器狀態(2026-09-07 補完設計落差任務書任務 2)—— 用 React Context 存在記憶體裡,
// 不寫 localStorage、不掛在登入態上,重新整理或換分頁就會回到預設「全部」,任務書明確允許
// 這樣做(「不用做成登入態的一部分」)。Provider 掛在 app/layout.tsx(持續存在的 root
// layout),不是掛在 AppShell 裡——AppShell 是每個頁面自己 render 的,如果 Provider 掛
// 在那裡,client-side 換頁(next/link 導航,不是整頁重新整理)也會重置狀態,體驗會很怪
// (切個範圍,點一個連結,範圍就不見了)。掛在 layout.tsx 才能在同一個分頁內,換頁時保留
// 目前選的範圍,只有重新整理/開新分頁才重置。

import { createContext, useContext, useState } from "react";
import type { OwnershipScope } from "@/lib/api";

interface ScopeContextValue {
  scope: OwnershipScope | null; // null = 全部,不篩選
  setScope: (scope: OwnershipScope | null) => void;
}

const ScopeContext = createContext<ScopeContextValue | null>(null);

export function ScopeProvider({ children }: { children: React.ReactNode }) {
  const [scope, setScope] = useState<OwnershipScope | null>(null);
  return <ScopeContext.Provider value={{ scope, setScope }}>{children}</ScopeContext.Provider>;
}

export function useScope(): ScopeContextValue {
  const ctx = useContext(ScopeContext);
  if (!ctx) throw new Error("useScope() 必須在 <ScopeProvider> 底下使用(見 app/layout.tsx)");
  return ctx;
}
