"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ThemeToggle() {
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

  return (
    <Button variant="ghost" size="icon" onClick={toggle} aria-label="切換深色模式">
      {isDark ? <Sun size={16} /> : <Moon size={16} />}
    </Button>
  );
}
