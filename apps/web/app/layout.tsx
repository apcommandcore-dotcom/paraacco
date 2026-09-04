import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "paraacco — 事務所會計",
  description: "採購／資產／文件稽核型記帳平台(Atelier Parallel 內部平台)",
};

// 深色模式初始化 —— 在 hydration 前用 inline script 讀 localStorage 設定
// <html data-theme>,避免先閃一次亮色再切換(FOUC)。沒有存過偏好時預設亮色
// (規格文件的線框視覺本來就是以亮色為主設計的)。
const themeInitScript = `
(function () {
  try {
    var stored = localStorage.getItem("paraacco-theme");
    if (stored === "dark") document.documentElement.setAttribute("data-theme", "dark");
  } catch (e) {}
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant">
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="font-sans text-[15px] leading-relaxed" style={{ margin: 0 }}>
        {children}
      </body>
    </html>
  );
}
