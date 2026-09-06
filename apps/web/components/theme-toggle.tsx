"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ThemeToggleProps {
  /** "icon"(預設,圓形圖示按鈕)或 "row"(比照 VaultLink 設計稿側邊欄底部那種文字列樣式)。
   *  兩種只是外觀,底層都是同一份 isDark state + 同一套 localStorage 邏輯,不是兩套並存。 */
  variant?: "icon" | "row";
}

export function ThemeToggle({ variant = "icon" }: ThemeToggleProps) {
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    setIsDark(document.documentElement.getAttribute("data-theme") === "dark");
  }, []);

  function toggle() {
    const next = !isDark;
    setIsDark(next);
    document.documentElement.setAttribute("data-theme", next ? "dark" : "light");
    try {
      localStorage.setItem("paraacco-theme", next ? "dark" : "light");
    } catch {
      // localStorage 不可用時(私密瀏覽模式等)就不記憶偏好,不影響切換本身。
    }
  }

  if (variant === "row") {
    return (
      <button
        type="button"
        onClick={toggle}
        aria-label="切換深色模式"
        className="flex w-full items-center justify-between px-4 py-3 text-left text-xs text-nav-text hover:bg-nav-sub hover:text-foreground"
      >
        <span>{isDark ? "深色模式" : "淺色模式"}</span>
        <span className="font-mono text-[9.5px] tracking-wide text-foreground-3">切換 TOGGLE</span>
      </button>
    );
  }

  return (
    <Button variant="ghost" size="icon" onClick={toggle} aria-label="切換深色模式">
      {isDark ? <Sun size={16} /> : <Moon size={16} />}
    </Button>
  );
}
