import { describe, expect, it } from "vitest";
import {
  LOCALE_COOKIE_NAME,
  formatLocaleDateTime,
  formatLocaleNumber,
  getCategoryDisplayName,
  getMessages,
  getValidationMessage,
  parseLocale,
} from "@/lib/i18n";

describe("i18n helpers", () => {
  it("defaults unsupported locale values to Chinese", () => {
    expect(LOCALE_COOKIE_NAME).toBe("billboard-locale");
    expect(parseLocale(undefined)).toBe("zh-CN");
    expect(parseLocale("")).toBe("zh-CN");
    expect(parseLocale("fr-FR")).toBe("zh-CN");
    expect(parseLocale("en-US")).toBe("en-US");
  });

  it("returns UI messages for both supported locales", () => {
    expect(getMessages("zh-CN").nav.home).toBe("首页");
    expect(getMessages("zh-CN").login.submit).toBe("登录");
    expect(getMessages("en-US").nav.home).toBe("Home");
    expect(getMessages("en-US").login.submit).toBe("Log in");
  });

  it("maps built-in category names only at display time", () => {
    expect(getCategoryDisplayName("Groceries", "zh-CN")).toBe("买菜");
    expect(getCategoryDisplayName("Salary", "zh-CN")).toBe("工资");
    expect(getCategoryDisplayName("Childcare", "zh-CN")).toBe("育儿");
    expect(getCategoryDisplayName("Parent Care", "zh-CN")).toBe("孝心");
    expect(getCategoryDisplayName("Custom Family", "zh-CN")).toBe("Custom Family");
    expect(getCategoryDisplayName("Groceries", "en-US")).toBe("Groceries");
    expect(getCategoryDisplayName("Childcare", "en-US")).toBe("Childcare");
  });

  it("formats numbers and dates with the selected locale", () => {
    expect(formatLocaleNumber(1234, "zh-CN")).toBe("1,234");
    expect(formatLocaleNumber(1234, "en-US")).toBe("1,234");
    expect(formatLocaleDateTime(new Date("2026-04-29T14:10:00.000Z"), "zh-CN")).toContain("4月29日");
    expect(formatLocaleDateTime(new Date("2026-04-29T14:10:00.000Z"), "en-US")).toContain("Apr");
  });

  it("maps known validation messages to the selected locale", () => {
    expect(getValidationMessage("Select a category", "zh-CN", "save")).toBe("请选择分类");
    expect(
      getValidationMessage("Enter a valid amount with up to two decimals", "zh-CN", "save"),
    ).toBe("请输入有效金额");
    expect(getValidationMessage("Amount must be greater than zero", "zh-CN", "save")).toBe(
      "金额必须大于 0",
    );
    expect(getValidationMessage("Select a category", "en-US", "save")).toBe("Select a category");
    expect(getValidationMessage("Database unavailable", "zh-CN", "save")).toBe("Database unavailable");
    expect(getValidationMessage(undefined, "zh-CN", "delete")).toBe("无法删除记录");
  });
});
