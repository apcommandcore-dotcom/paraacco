import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "paraacco — 事務所會計",
  description: "採購／資產／文件稽核型記帳平台(Atelier Parallel 內部平台)",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
