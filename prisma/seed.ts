import argon2 from "argon2";
import { CategoryType, HouseholdRole, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const expenseCategories = [
  "Dining",
  "Groceries",
  "Transport",
  "Daily Use",
  "Home",
  "Medical",
  "Childcare",
  "Parent Care",
  "Entertainment",
  "Social",
  "Travel",
  "Other",
];
const incomeCategories = ["Salary", "Bonus", "Reimbursement", "Refund", "Investment", "Other"];

function requireEnv(name: string) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required seed env var: ${name}`);
  }

  return value;
}

async function main() {
  const household = await prisma.household.upsert({
    where: { id: "default-household" },
    update: {},
    create: {
      id: "default-household",
      name: process.env.SEED_HOUSEHOLD_NAME ?? "Household",
      baseCurrency: "CNY",
      timezone: "Asia/Shanghai",
    },
  });

  const users = [
    {
      email: requireEnv("SEED_USER_A_EMAIL"),
      password: requireEnv("SEED_USER_A_PASSWORD"),
      displayName: process.env.SEED_USER_A_NAME ?? "老公",
      memberName: process.env.SEED_USER_A_NAME ?? "老公",
    },
    {
      email: requireEnv("SEED_USER_B_EMAIL"),
      password: requireEnv("SEED_USER_B_PASSWORD"),
      displayName: process.env.SEED_USER_B_NAME ?? "老婆",
      memberName: process.env.SEED_USER_B_NAME ?? "老婆",
    },
  ];

  for (const [index, user] of users.entries()) {
    const passwordHash = await argon2.hash(user.password);
    const created = await prisma.user.upsert({
      where: { email: user.email },
      update: {
        displayName: user.displayName,
        passwordHash,
      },
      create: {
        email: user.email,
        displayName: user.displayName,
        passwordHash,
      },
    });

    await prisma.householdMember.upsert({
      where: { userId: created.id },
      update: {
        memberName: user.memberName,
      },
      create: {
        householdId: household.id,
        userId: created.id,
        memberName: user.memberName,
        role: index === 0 ? HouseholdRole.OWNER : HouseholdRole.MEMBER,
      },
    });
  }

  for (const [sortOrder, name] of expenseCategories.entries()) {
    await prisma.category.upsert({
      where: { type_name: { type: CategoryType.EXPENSE, name } },
      update: { isActive: true, sortOrder },
      create: { type: CategoryType.EXPENSE, name, sortOrder },
    });
  }

  for (const [sortOrder, name] of incomeCategories.entries()) {
    await prisma.category.upsert({
      where: { type_name: { type: CategoryType.INCOME, name } },
      update: { isActive: true, sortOrder },
      create: { type: CategoryType.INCOME, name, sortOrder },
    });
  }
}

main().finally(async () => {
  await prisma.$disconnect();
});
