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
    // suppressHydrationWarning:themeInitScript 會在 hydration 前用 imperative DOM API
    // 幫 <html> 加上 data-theme,React 的伺服器渲染結果本來就不會有這個屬性(值只存在
    // localStorage,伺服器端不知道)——這是預期的一次性差異,不是真正的 hydration bug,
    // 比照 next-themes 這類套件的標準做法加這個屬性讓 React 不要為了這一個屬性報警告。
    <html lang="zh-Hant" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="font-sans text-[15px] leading-relaxed" style={{ margin: 0 }}>
        {children}
      </body>
    </html>
  );
}
