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
    Groceries: "买菜",
    Home: "居家",
    Investment: "投资",
    Medical: "医疗",
    Other: "其他",
    "Parent Care": "孝心",
    Refund: "退款",
    Reimbursement: "报销",
    Salary: "工资",
    Social: "社交",
    Transport: "交通",
    Travel: "旅行",
    "Daily Use": "日用",
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
