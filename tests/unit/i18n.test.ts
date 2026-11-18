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
    expect(getMessages("zh-CN").nav.add).toBe("记一笔");
    expect(getMessages("zh-CN").nav.records).toBe("记录");
    expect(getMessages("zh-CN").home.range.all).toBe("全部");
    expect(getMessages("zh-CN").home.categories.title).toBe("分类分析");
    expect(getMessages("zh-CN").common.sort).toBe("排序");
    expect(getMessages("zh-CN").common.more).toBe("更多");
    expect(getMessages("zh-CN").common.collapse).toBe("收起");
    expect(getMessages("zh-CN").common.amountHighToLow).toBe("金额从高到低");
    expect(getMessages("zh-CN").common.amountLowToHigh).toBe("金额从低到高");
    expect(getMessages("zh-CN").common.search).toBe("搜索记录");
    expect(getMessages("zh-CN").common.searchPlaceholder).toBe("备注、分类或记账人");
    expect(getMessages("zh-CN").common.searchAction).toBe("搜索");
    expect(getMessages("zh-CN").common.clearSearch).toBe("清空搜索");
    expect(getMessages("zh-CN").common.routeErrorTitle).toBe("页面加载失败");
    expect(getMessages("zh-CN").common.routeErrorRetry).toBe("重试页面");
    expect(getMessages("zh-CN").login.submit).toBe("登录");
    expect(getMessages("zh-CN").add.slowSaving).toBe("网络较慢，仍在保存…");
    expect(getMessages("zh-CN").add.unknownTitle).toBe("保存结果尚未确认");
    expect(getMessages("zh-CN").add.retryConfirmation).toBe("重新确认保存");
    expect(getMessages("zh-CN").add.checkRecords).toBe("去记录页核对");
    expect(getMessages("en-US").nav.home).toBe("Home");
    expect(getMessages("en-US").nav.add).toBe("Add");
    expect(getMessages("en-US").nav.records).toBe("Records");
    expect(getMessages("en-US").home.range.all).toBe("All");
    expect(getMessages("en-US").home.categories.title).toBe("Category analysis");
    expect(getMessages("en-US").common.sort).toBe("Sort");
    expect(getMessages("en-US").common.more).toBe("More");
    expect(getMessages("en-US").common.collapse).toBe("Collapse");
    expect(getMessages("en-US").common.amountHighToLow).toBe("Amount high to low");
    expect(getMessages("en-US").common.amountLowToHigh).toBe("Amount low to high");
    expect(getMessages("en-US").common.search).toBe("Search records");
    expect(getMessages("en-US").common.searchPlaceholder).toBe("Note, category, or actor");
    expect(getMessages("en-US").common.searchAction).toBe("Search");
    expect(getMessages("en-US").common.clearSearch).toBe("Clear search");
    expect(getMessages("en-US").common.routeErrorTitle).toBe("Page failed to load");
    expect(getMessages("en-US").common.routeErrorRetry).toBe("Retry page");
    expect(getMessages("en-US").add.slowSaving).toBe("The network is slow. Still saving…");
    expect(getMessages("en-US").add.unknownTitle).toBe("Save result not confirmed");
    expect(getMessages("en-US").add.retryConfirmation).toBe("Confirm save again");
    expect(getMessages("en-US").add.checkRecords).toBe("Check records");
    expect(getMessages("en-US").login.submit).toBe("Log in");
  });

  it("includes import source and payment owner member messages", () => {
    const zh = getMessages("zh-CN");
    const en = getMessages("en-US");

    expect(zh.import.sources.wechatPay).toBe("微信支付");
    expect(zh.import.sources.alipay).toBe("支付宝");
    expect(zh.import.sources.cmb).toBe("招商银行");
    expect(zh.import.ownerMemberTitle).toBe("账单归属成员");
    expect(zh.import.errors["file-too-large"]).toBe("文件过大，请上传不超过 20MB 的文件。");
    expect(zh.import.errors["file-too-large"]).not.toContain(".xlsx");
    expect(zh.import.errors["file-too-large"]).not.toContain("随手记");
    expect(zh.import.errors["missing-source"]).toBe("请选择导入来源。");
    expect(zh.import.errors["unrecognized-wechat-pay-file"]).toBe(
      "无法识别微信支付账单格式。",
    );
    expect(zh.import.errors["unrecognized-alipay-file"]).toBe("无法识别支付宝账单格式。");
    expect(zh.import.errors["unsupported-alipay-file"]).toBe("支付宝仅支持 .csv 文件。");
    expect(zh.import.errors["unsupported-cmb-file"]).toBe("招商银行仅支持 .pdf 或 .zip 文件。");
    expect(zh.import.errors["unrecognized-cmb-file"]).toBe("无法识别招商银行流水格式。");
    expect(zh.import.errors["missing-cmb-zip-password"]).toBe("招商银行 ZIP 账单需要填写解压密码。");
    expect(zh.import.errors["unreadable-cmb-zip-file"]).toContain("只包含一个 PDF");
    expect(en.import.sources.wechatPay).toBe("WeChat Pay");
    expect(en.import.sources.alipay).toBe("Alipay");
    expect(en.import.sources.cmb).toBe("CMB");
    expect(en.import.ownerMemberTitle).toBe("Bill owner");
    expect(en.import.errors["file-too-large"]).toBe("File is too large. Upload a file up to 20MB.");
    expect(en.import.errors["file-too-large"]).not.toContain(".xlsx");
    expect(en.import.errors["file-too-large"]).not.toContain("Sui Shou Ji");
    expect(en.import.errors["missing-source"]).toBe("Choose an import source.");
    expect(en.import.errors["unrecognized-wechat-pay-file"]).toBe(
      "Could not recognize the WeChat Pay bill format.",
    );
    expect(en.import.errors["unrecognized-alipay-file"]).toBe(
      "Could not recognize the Alipay bill format.",
    );
    expect(en.import.errors["unsupported-alipay-file"]).toBe("Alipay only supports .csv files.");
    expect(en.import.errors["unsupported-cmb-file"]).toBe("CMB only supports .pdf or .zip files.");
    expect(en.import.errors["unrecognized-cmb-file"]).toBe(
      "Could not recognize the CMB statement format.",
    );
    expect(en.import.errors["missing-cmb-zip-password"]).toBe(
      "Enter the password for the CMB ZIP statement.",
    );
    expect(en.import.errors["unreadable-cmb-zip-file"]).toContain("contains one PDF");
  });

  it("includes localized payment refund outcome messages", () => {
    const zh = getMessages("zh-CN");
    const en = getMessages("en-US");

    expect(zh.import.refundOutcomeTitle).toBe("退款处理");
    expect(zh.import.refundReasons.fullyRefunded).toBe("已完全退款，自动跳过");
    expect(zh.import.refundReasons.manualAdjustment).toBe(
      "退款无法自动抵扣，请手工调整原支出",
    );
    expect(zh.import.draftChangedNotice).toBe("草稿状态已变化，请复核");
    expect(en.import.refundOutcomeTitle).toBe("Refund handling");
    expect(en.import.refundReasons.fullyRefunded).toBe(
      "Fully refunded; skipped automatically",
    );
    expect(en.import.refundReasons.manualAdjustment).toBe(
      "The refund could not be applied automatically; adjust the original record manually",
    );
    expect(en.import.draftChangedNotice).toBe(
      "The draft changed. Review it before confirming again.",
    );
  });

  it("maps built-in category names only at display time", () => {
    expect(getCategoryDisplayName("Shopping", "zh-CN")).toBe("购物");
    expect(getCategoryDisplayName("Study", "zh-CN")).toBe("学习");
    expect(getCategoryDisplayName("Salary", "zh-CN")).toBe("工资");
    expect(getCategoryDisplayName("Childcare", "zh-CN")).toBe("育儿");
    expect(getCategoryDisplayName("Parent Care", "zh-CN")).toBe("孝心");
    expect(getCategoryDisplayName("Groceries", "zh-CN")).toBe("Groceries");
    expect(getCategoryDisplayName("Custom Family", "zh-CN")).toBe("Custom Family");
    expect(getCategoryDisplayName("Shopping", "en-US")).toBe("Shopping");
    expect(getCategoryDisplayName("Study", "en-US")).toBe("Study");
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
    expect(getValidationMessage("Invalid transaction request ID", "zh-CN", "save")).toBe(
      "记账请求标识无效，请重新提交",
    );
    expect(
      getValidationMessage(
        "Transaction request conflicts with an existing transaction",
        "zh-CN",
        "save",
      ),
    ).toBe("该记账请求与已有记录不一致，请重新提交");
    expect(getValidationMessage("Select a category", "en-US", "save")).toBe("Select a category");
    expect(getValidationMessage("Database unavailable", "zh-CN", "save")).toBe("Database unavailable");
    expect(getValidationMessage(undefined, "zh-CN", "delete")).toBe("无法删除记录");
  });
});
