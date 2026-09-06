import type { Config } from "tailwindcss";

// 深色模式:data-theme 屬性掛最外層(見 app/layout.tsx),不用 Tailwind 內建的 class 策略。
// 顏色 token 2026-09-06 換成 var(--x) 直接參照 app/globals.css 的設計系統變數(不是舊版
// hsl(var(--x)) 那種要存 HSL 三元組的寫法,見 globals.css 開頭註解)。
const config: Config = {
  darkMode: ["selector", '[data-theme="dark"]'],
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        border: "var(--brand)",
        line: {
          DEFAULT: "var(--line)",
          2: "var(--line-2)",
        },
        input: "var(--line)",
        ring: "var(--brand)",
        background: "var(--background)",
        foreground: {
          DEFAULT: "var(--foreground)",
          2: "var(--foreground-2)",
          3: "var(--foreground-3)",
        },
        muted: {
          DEFAULT: "var(--surface-2)",
          foreground: "var(--foreground-2)",
        },
        card: {
          DEFAULT: "var(--surface)",
          foreground: "var(--foreground)",
        },
        primary: {
          DEFAULT: "var(--brand)",
          foreground: "var(--on-brand)",
        },
        secondary: {
          DEFAULT: "var(--surface-2)",
          foreground: "var(--foreground)",
        },
        accent: {
          DEFAULT: "var(--surface-2)",
          foreground: "var(--foreground)",
        },
        destructive: {
          DEFAULT: "var(--err)",
          foreground: "#FFFFFF",
          bg: "var(--err-bg)",
          line: "var(--err-line)",
        },
        warning: {
          DEFAULT: "var(--warn)",
          foreground: "#FFFFFF",
          bg: "var(--warn-bg)",
          line: "var(--warn-line)",
        },
        ok: {
          DEFAULT: "var(--ok)",
          bg: "var(--ok-bg)",
          line: "var(--ok-line)",
        },
        info: {
          DEFAULT: "var(--info)",
          bg: "var(--info-bg)",
          line: "var(--info-line)",
        },
        per: {
          DEFAULT: "var(--per)",
          bg: "var(--per-bg)",
          line: "var(--per-line)",
        },
        corp: {
          DEFAULT: "var(--corp)",
          bg: "var(--corp-bg)",
          line: "var(--corp-line)",
        },
        nav: {
          DEFAULT: "var(--nav)",
          sub: "var(--nav-sub)",
          text: "var(--nav-text)",
        },
      },
      fontFamily: {
        sans: ["var(--font-noto-sans-tc)", "'PingFang TC'", "'Microsoft JhengHei'", "system-ui", "sans-serif"],
        mono: ["var(--font-ibm-plex-mono)", "monospace"],
      },
      borderRadius: {
        DEFAULT: "0px",
      },
    },
  },
  plugins: [],
};

export default config;
