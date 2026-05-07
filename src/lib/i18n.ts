export const LOCALE_COOKIE_NAME = "billboard-locale";

export const supportedLocales = ["zh-CN", "en-US"] as const;
export type Locale = (typeof supportedLocales)[number];

export type ActionErrorKind = "save" | "update" | "delete";

const categoryDisplayNames = {
  "zh-CN": {
    Bonus: "奖金",
    Childcare: "育儿",
    Dining: "餐饮",
    Entertainment: "娱乐",
    Home: "居家",
    Investment: "投资",
    Medical: "医疗",
    Other: "其他",
    "Parent Care": "孝心",
    Refund: "退款",
    Reimbursement: "报销",
    Salary: "工资",
    Shopping: "购物",
    Social: "社交",
    Study: "学习",
    Transport: "交通",
    Travel: "旅行",
  },
  "en-US": {},
} as const;

export const messages = {
  "zh-CN": {
    metadata: {
      title: "家庭记账",
      description: "快速记录两人家庭收支。",
    },
    app: {
      brand: "BillBoard",
      tagline: "家庭记账",
    },
    language: {
      switchLanguage: "切换语言",
      target: "EN",
    },
    nav: {
      home: "首页",
      add: "记一笔",
      records: "记录",
    },
    common: {
      addAnother: "再记一笔",
      allCategories: "全部分类",
      allTypes: "全部类型",
      amount: "金额",
      actor: "记账人",
      category: "分类",
      close: "关闭",
      createdBy: "创建人",
      expense: "支出",
      income: "收入",
      importRecords: "导入",
      noNote: "无备注",
      note: "备注",
      optional: "可选",
      returnHome: "返回首页",
      saving: "保存中...",
      type: "类型",
      view: "查看",
      when: "时间",
      who: "成员",
      tx: "笔",
    },
    range: {
      label: "范围",
      thisMonth: "本月",
      last7Days: "最近 7 天",
      last30Days: "最近 30 天",
      last12Months: "最近 12 个月",
    },
    perspective: {
      household: "家庭",
      me: "老公",
      spouse: "老婆",
    },
    login: {
      eyebrow: "BillBoard",
      title: "家庭记账",
      description: "登录你的家庭共享账本。",
      email: "邮箱",
      password: "密码",
      submit: "登录",
      invalidCredentials: "邮箱或密码不正确",
    },
    home: {
      eyebrow: "家庭概览",
      title: "首页",
      description: "按选择的时间范围和成员视角即时查看家庭收支。",
      addTransaction: "记一笔",
      transactionCount: (countLabel: string) => `${countLabel} 笔记录`,
      summary: {
        incomeTitle: "收入",
        incomeDetail: "查看当前视图的收入记录",
        expenseTitle: "支出",
        expenseDetail: "查看当前视图的支出记录",
        netTitle: "结余",
        netDetail: "收入减支出的净额",
        transactionsTitle: "记录",
        transactionsDetail: "打开当前筛选下的记录列表",
      },
    },
    trend: {
      title: "趋势",
      empty: "当前筛选下还没有记录。",
      daily: "每日收入和支出合计。",
      monthly: "每月收入和支出合计。",
      income: "收入",
      expense: "支出",
    },
    categories: {
      title: "支出分类",
      description: "当前范围内支出集中在哪里。",
      empty: "当前筛选下还没有支出记录。",
      transactionCount: (countLabel: string) => `${countLabel} 笔记录`,
    },
    recent: {
      title: "近期记录",
      description: "直接查看影响当前视图的记录。",
      empty: "当前筛选下还没有记录。",
    },
    add: {
      eyebrow: "快速记录",
      title: "记一笔",
      description: "快速记录家庭收入和支出，不离开当前应用。",
      successMessage: "记录已保存",
      successDetail: (typeLabel: string, amount: string) => `${typeLabel}：${amount}`,
      save: "保存记录",
    },
    records: {
      eyebrow: "历史",
      title: "记录",
      description: "快速筛选、查看并修改家庭历史记录。",
      empty: "当前筛选下没有记录。试试扩大时间范围或清除筛选。",
    },
    import: {
      eyebrow: "账单导入",
      title: "导入记录",
      description: "选择来源并上传 .xlsx，补齐分类映射后确认入账。",
      uploadTitle: "上传文件",
      uploadDescription: "选择导入来源和对应的 .xlsx 文件。",
      source: "来源",
      sources: {
        suiShouJi: "随手记",
        wechatPay: "微信支付",
      },
      ownerMemberTitle: "账单归属成员",
      ownerMemberDescription: "微信账单没有独立成员字段，这里选择的成员会用于这份草稿的所有可导入记录。",
      saveOwnerMember: "保存成员",
      file: "文件",
      upload: "上传并解析",
      backToRecords: "返回记录",
      summaryTitle: "导入概览",
      fileName: "文件",
      totalRows: "总行数",
      readyRows: "可导入",
      needsMappingRows: "待映射",
      duplicateRows: "疑似重复",
      sourceDuplicateRows: "同源重复",
      skippedRows: "已跳过",
      invalidRows: "无效行",
      mappingTitle: "分类映射",
      mappingDescription: "按类型、一级分类、二级分类聚合，只能选择现有启用分类。",
      mappingCount: (count: number) => `${count} 行`,
      saveMappings: "保存映射",
      duplicateTitle: "疑似重复确认",
      duplicateDescription: "默认保留；如确认已记过，可选择跳过。",
      importedRow: "导入行",
      duplicateCandidate: "候选重复",
      hiddenDuplicateRows: (count: number) => `还有 ${count} 行未显示`,
      hiddenDuplicateCandidates: (count: number) => `还有 ${count} 个候选未显示`,
      manualSource: "手工",
      keep: "保留",
      skip: "跳过",
      saveDecisions: "保存选择",
      confirmImport: "确认导入",
      confirmDisabled: "还有分类未映射，暂不能确认导入。",
      completedTitle: "导入已完成",
      completedDescription: "记录已写入家庭账本，可以返回记录页查看。",
      errors: {
        "file-too-large": "文件过大，请上传不超过 20MB 的 .xlsx 文件。",
        "missing-source": "请选择导入来源。",
        "missing-draft": "缺少导入草稿，请重新上传文件。",
        "unrecognized-file": "无法识别随手记导出格式。",
        "unrecognized-wechat-pay-file": "无法识别微信支付账单格式。",
        "upload-failed": "上传解析失败，请稍后重试。",
        "unsupported-file": "仅支持 .xlsx 文件。",
      },
    },
    editor: {
      title: "编辑记录",
      createdBy: (date: string, member: string) => `${date} · 创建人 ${member}`,
      saveChanges: "保存修改",
      deleteRecord: "删除记录",
      deleting: "删除中...",
      deleteConfirm: "删除这条记录？",
    },
    actions: {
      couldNotSave: "无法保存记录",
      couldNotUpdate: "无法更新记录",
      couldNotDelete: "无法删除记录",
      validation: {
        "Select income or expense": "请选择收入或支出",
        "Enter a valid amount": "请输入有效金额",
        "Enter a valid amount with up to two decimals": "请输入有效金额",
        "Amount must be greater than 0": "金额必须大于 0",
        "Amount must be greater than zero": "金额必须大于 0",
        "Select a category": "请选择分类",
        "Select who made the transaction": "请选择成员",
        "Choose when the transaction happened": "请选择记录发生时间",
        "Choose a valid date and time": "请选择有效日期和时间",
      },
    },
  },
  "en-US": {
    metadata: {
      title: "Household Accounting",
      description: "Fast two-person household accounting.",
    },
    app: {
      brand: "BillBoard",
      tagline: "Household accounting",
    },
    language: {
      switchLanguage: "Switch language",
      target: "中文",
    },
    nav: {
      home: "Home",
      add: "Add",
      records: "Records",
    },
    common: {
      addAnother: "Add another",
      allCategories: "All categories",
      allTypes: "All types",
      amount: "Amount",
      actor: "Actor",
      category: "Category",
      close: "Close",
      createdBy: "Created by",
      expense: "Expense",
      income: "Income",
      importRecords: "Import",
      noNote: "No note",
      note: "Note",
      optional: "Optional",
      returnHome: "Return home",
      saving: "Saving...",
      type: "Type",
      view: "View",
      when: "When",
      who: "Who",
      tx: "tx",
    },
    range: {
      label: "Range",
      thisMonth: "This Month",
      last7Days: "Last 7 Days",
      last30Days: "Last 30 Days",
      last12Months: "Last 12 Months",
    },
    perspective: {
      household: "Household",
      me: "Me",
      spouse: "Spouse",
    },
    login: {
      eyebrow: "BillBoard",
      title: "Household Accounting",
      description: "Sign in to your shared household ledger.",
      email: "Email",
      password: "Password",
      submit: "Log in",
      invalidCredentials: "Invalid email or password",
    },
    home: {
      eyebrow: "Household overview",
      title: "Home",
      description: "Household reporting updates instantly with the selected range and perspective.",
      addTransaction: "Add transaction",
      transactionCount: (countLabel: string, count: number) =>
        `${countLabel} transaction${count === 1 ? "" : "s"} in view`,
      summary: {
        incomeTitle: "Income",
        incomeDetail: "Review income records for this view",
        expenseTitle: "Expense",
        expenseDetail: "Review expense records for this view",
        netTitle: "Net",
        netDetail: "Net across income and expenses",
        transactionsTitle: "Transactions",
        transactionsDetail: "Open the records list with these filters",
      },
    },
    trend: {
      title: "Trend",
      empty: "No activity yet for the selected filters.",
      daily: "Daily income and expense totals.",
      monthly: "Monthly income and expense totals.",
      income: "Income",
      expense: "Expense",
    },
    categories: {
      title: "Expense categories",
      description: "Where spending is concentrated in this range.",
      empty: "No expense activity yet for the selected filters.",
      transactionCount: (countLabel: string, count: number) =>
        `${countLabel} transaction${count === 1 ? "" : "s"}`,
    },
    recent: {
      title: "Recent transactions",
      description: "Jump straight into the records that shaped this view.",
      empty: "No transactions yet for the selected filters.",
    },
    add: {
      eyebrow: "Quick entry",
      title: "Add transaction",
      description: "Capture household income and expenses without leaving the app shell.",
      successMessage: "Transaction saved",
      successDetail: (typeLabel: string, amount: string) => `${typeLabel}: ${amount}`,
      save: "Save transaction",
    },
    records: {
      eyebrow: "History",
      title: "Records",
      description: "Review household history, filter it quickly, and adjust records in place.",
      empty: "No records match the current filters. Try a wider range or clear a filter.",
    },
    import: {
      eyebrow: "Bill import",
      title: "Import records",
      description: "Choose a source, upload an .xlsx file, map categories, then confirm the import.",
      uploadTitle: "Upload file",
      uploadDescription: "Choose the import source and matching .xlsx file.",
      source: "Source",
      sources: {
        suiShouJi: "Sui Shou Ji",
        wechatPay: "WeChat Pay",
      },
      ownerMemberTitle: "Bill owner",
      ownerMemberDescription:
        "WeChat bills do not include separate member fields. This member is used for all importable rows in this draft.",
      saveOwnerMember: "Save member",
      file: "File",
      upload: "Upload and parse",
      backToRecords: "Back to records",
      summaryTitle: "Import summary",
      fileName: "File",
      totalRows: "Total rows",
      readyRows: "Ready",
      needsMappingRows: "Needs mapping",
      duplicateRows: "Possible duplicates",
      sourceDuplicateRows: "Source duplicates",
      skippedRows: "Skipped",
      invalidRows: "Invalid",
      mappingTitle: "Category mappings",
      mappingDescription:
        "Grouped by type, primary category, and secondary category. Choose an existing active category.",
      mappingCount: (count: number) => `${count} row${count === 1 ? "" : "s"}`,
      saveMappings: "Save mappings",
      duplicateTitle: "Possible duplicate review",
      duplicateDescription: "Rows are kept by default. Skip only when the transaction already exists.",
      importedRow: "Imported row",
      duplicateCandidate: "Duplicate candidate",
      hiddenDuplicateRows: (count: number) => `${count} more row${count === 1 ? "" : "s"} not shown`,
      hiddenDuplicateCandidates: (count: number) =>
        `${count} more candidate${count === 1 ? "" : "s"} not shown`,
      manualSource: "Manual",
      keep: "Keep",
      skip: "Skip",
      saveDecisions: "Save choices",
      confirmImport: "Confirm import",
      confirmDisabled: "Resolve category mappings before confirming the import.",
      completedTitle: "Import completed",
      completedDescription: "Records were written to the household ledger. Return to records to review them.",
      errors: {
        "file-too-large": "File is too large. Upload an .xlsx file up to 20MB.",
        "missing-source": "Choose an import source.",
        "missing-draft": "Import draft is missing. Upload the file again.",
        "unrecognized-file": "Could not recognize the Sui Shou Ji export format.",
        "unrecognized-wechat-pay-file": "Could not recognize the WeChat Pay bill format.",
        "upload-failed": "Upload parsing failed. Try again later.",
        "unsupported-file": "Only .xlsx files are supported.",
      },
    },
    editor: {
      title: "Edit record",
      createdBy: (date: string, member: string) => `${date} • created by ${member}`,
      saveChanges: "Save changes",
      deleteRecord: "Delete record",
      deleting: "Deleting...",
      deleteConfirm: "Delete this record?",
    },
    actions: {
      couldNotSave: "Could not save the transaction",
      couldNotUpdate: "Could not update the record",
      couldNotDelete: "Could not delete the record",
      validation: {},
    },
  },
} as const;

export type Messages = (typeof messages)[Locale];

export function parseLocale(value: unknown): Locale {
  return value === "en-US" ? "en-US" : "zh-CN";
}

export function getMessages(locale: Locale) {
  return messages[locale];
}

export function getCategoryDisplayName(categoryName: string, locale: Locale) {
  const displayNames = categoryDisplayNames[locale] as Partial<Record<string, string>>;

  return displayNames[categoryName] ?? categoryName;
}

export function formatLocaleNumber(value: number, locale: Locale) {
  return new Intl.NumberFormat(locale).format(value);
}

export function formatLocaleDateTime(date: Date, locale: Locale) {
  return new Intl.DateTimeFormat(locale, {
    timeZone: "Asia/Shanghai",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function getValidationMessage(
  message: string | undefined,
  locale: Locale,
  kind: ActionErrorKind,
) {
  const actionMessages = messages[locale].actions;

  if (!message) {
    return kind === "delete"
      ? actionMessages.couldNotDelete
      : kind === "update"
        ? actionMessages.couldNotUpdate
        : actionMessages.couldNotSave;
  }

  if (locale === "zh-CN") {
    const validationMessages = actionMessages.validation as Partial<Record<string, string>>;

    return validationMessages[message] ?? message;
  }

  return message;
}
