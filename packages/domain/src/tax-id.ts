// 營利事業統一編號檢查 —— 2026-09-26 新增(管理後台「輸入統編直接新增供應商」)。
//
// 財政部規則:8 碼數字,權數 1,2,1,2,1,2,4,1,各位數乘積的「十位數 + 個位數」相加得 Z。
// Z 能被 5 整除即合法(2023-04 起由「被 10 整除」放寬為「被 5 整除」,舊統編同樣相容)。
// 第 7 碼為 7 時乘積 28 → 2+8=10 → 1+0=1 或 0 兩種都算,(Z+1) 能被 5 整除也合法。

const WEIGHTS = [1, 2, 1, 2, 1, 2, 4, 1];

export function normalizeTaxId(input: string): string {
  return input.replace(/\s|-/g, "");
}

export function isValidTaxId(input: string): boolean {
  const id = normalizeTaxId(input);
  if (!/^\d{8}$/.test(id)) return false;
  let z = 0;
  for (let i = 0; i < 8; i++) {
    const p = Number(id[i]) * WEIGHTS[i];
    z += Math.floor(p / 10) + (p % 10);
  }
  if (z % 5 === 0) return true;
  return id[6] === "7" && (z + 1) % 5 === 0;
}
