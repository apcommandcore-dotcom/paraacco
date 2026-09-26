import { describe, expect, it } from "vitest";
import { advanceDueDate, computeWarrantyStatus } from "./warranty-status";

describe("advanceDueDate", () => {
  it("雙月:水電瓦斯常見週期", () => {
    expect(advanceDueDate("2026-10-28", "bimonthly")).toBe("2026-12-28");
    expect(advanceDueDate("2026-12-15", "bimonthly")).toBe("2027-02-15");
  });
  it("月底日夾到短月份最後一天,不溢位", () => {
    expect(advanceDueDate("2026-01-31", "monthly")).toBe("2026-02-28");
    expect(advanceDueDate("2027-12-31", "bimonthly")).toBe("2028-02-29");
  });
  it("季、半年、年", () => {
    expect(advanceDueDate("2026-11-30", "quarterly")).toBe("2027-02-28");
    expect(advanceDueDate("2026-05-31", "semiannual")).toBe("2026-11-30");
    expect(advanceDueDate("2026-10-15", "yearly")).toBe("2027-10-15");
  });
  it("一次性沒有下一期", () => {
    expect(advanceDueDate("2026-10-15", "one_time")).toBeNull();
  });
  it("格式錯誤直接丟錯,不默默算錯", () => {
    expect(() => advanceDueDate("2026/10/15", "monthly")).toThrow();
  });
});

describe("computeWarrantyStatus", () => {
  const now = new Date("2026-09-26T03:00:00Z");
  it("已過期/即將到期/使用中", () => {
    expect(computeWarrantyStatus({ endDate: "2026-09-04", reminderDaysBefore: 30 }, now)).toBe("expired");
    expect(computeWarrantyStatus({ endDate: "2026-10-05", reminderDaysBefore: 14 }, now)).toBe("due_soon");
    expect(computeWarrantyStatus({ endDate: "2026-12-01", reminderDaysBefore: 14 }, now)).toBe("active");
  });
});
