// 金額一律以「分」(最小貨幣單位的整數)存放,避免浮點數誤差;顯示時才轉換成千分位字串。

export function toCents(amount: number): number {
  return Math.round(amount * 100);
}

export function fromCents(cents: number): number {
  return cents / 100;
}

export function formatAmount(cents: number, currency = "TWD"): string {
  const value = fromCents(cents);
  const formatted = value.toLocaleString("zh-TW", { maximumFractionDigits: 0 });
  return currency === "TWD" ? formatted : `${formatted} ${currency}`;
}
