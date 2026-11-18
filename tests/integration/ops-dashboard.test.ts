import { existsSync } from "node:fs";

if (existsSync(".env")) {
  process.loadEnvFile?.(".env");
}

if (existsSync(".env.example")) {
  process.loadEnvFile?.(".env.example");
}

import { AppEventType, HouseholdRole, OpsAuditAction, type Prisma } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

let db: typeof import("@/lib/db").physicalDb;
let queryOpsDashboard: typeof import("@/lib/ops/dashboard").queryOpsDashboard;

const createdEventIds: string[] = [];
const createdAuditLogIds: string[] = [];
const createdAppSessionIds: string[] = [];
const createdHouseholdIds: string[] = [];
const createdLoginThrottleEmails: string[] = [];
const createdUserIds: string[] = [];

beforeAll(async () => {
  assertSafeTestDatabase();
  ({ physicalDb: db } = await import("@/lib/db"));
  ({ queryOpsDashboard } = await import("@/lib/ops/dashboard"));
});

afterEach(async () => {
  vi.restoreAllMocks();

  if (createdEventIds.length > 0) {
    const eventIdsToDelete = [...createdEventIds];

    await db.appEvent.deleteMany({
      where: { id: { in: eventIdsToDelete } },
    });
    createdEventIds.length = 0;
  }

  if (createdAuditLogIds.length > 0) {
    const auditLogIdsToDelete = [...createdAuditLogIds];

    await db.opsAuditLog.deleteMany({
      where: { id: { in: auditLogIdsToDelete } },
    });
    createdAuditLogIds.length = 0;
  }

  if (createdAppSessionIds.length > 0) {
    const appSessionIdsToDelete = [...createdAppSessionIds];

    await db.appSession.deleteMany({
      where: { id: { in: appSessionIdsToDelete } },
    });
    createdAppSessionIds.length = 0;
  }

  if (createdHouseholdIds.length > 0) {
    const householdIdsToDelete = [...createdHouseholdIds];

    await db.household.deleteMany({
      where: { id: { in: householdIdsToDelete } },
    });
    createdHouseholdIds.length = 0;
  }

  if (createdLoginThrottleEmails.length > 0) {
    const emailsToDelete = [...createdLoginThrottleEmails];

    await db.loginThrottle.deleteMany({
      where: { email: { in: emailsToDelete } },
    });
    createdLoginThrottleEmails.length = 0;
  }

  if (createdUserIds.length > 0) {
    const userIdsToDelete = [...createdUserIds];

    await db.user.deleteMany({
      where: { id: { in: userIdsToDelete } },
    });
    createdUserIds.length = 0;
  }
});

afterAll(async () => {
  await db.$disconnect();
});

function assertSafeTestDatabase() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Ops dashboard integration tests must not run with NODE_ENV=production");
  }

  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for ops dashboard integration tests");
  }

  const parsedUrl = new URL(databaseUrl);
  const databaseName = parsedUrl.pathname.replace(/^\//, "");
  const hostIsLocal = parsedUrl.hostname === "127.0.0.1" || parsedUrl.hostname === "localhost";
  const databaseIsDevOrTest = /(?:dev|test)/i.test(databaseName);

  if (!hostIsLocal || !databaseIsDevOrTest) {
    throw new Error("Refusing to run ops dashboard integration tests against a non-dev/test database");
  }
}

async function createHouseholdFixture() {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const household = await db.household.create({
    data: {
      name: `Ops Dashboard ${suffix}`,
    },
  });
  createdHouseholdIds.push(household.id);

  const [husbandUser, wifeUser] = await Promise.all([
    db.user.create({
      data: {
        displayName: "Ops Husband",
        email: `ops-dashboard-husband-${suffix}@example.com`,
        passwordHash: "not-used",
      },
    }),
    db.user.create({
      data: {
        displayName: "Ops Wife",
        email: `ops-dashboard-wife-${suffix}@example.com`,
        passwordHash: "not-used",
      },
    }),
  ]);
  createdUserIds.push(husbandUser.id, wifeUser.id);

  const [husbandMember, wifeMember] = await Promise.all([
    db.householdMember.create({
      data: {
        householdId: household.id,
        memberName: "Ops Husband",
        role: HouseholdRole.OWNER,
        userId: husbandUser.id,
      },
    }),
    db.householdMember.create({
      data: {
        householdId: household.id,
        memberName: "Ops Wife",
        role: HouseholdRole.MEMBER,
        userId: wifeUser.id,
      },
    }),
  ]);

  return { household, husbandMember, husbandUser, wifeMember, wifeUser };
}

async function createAppEvent(data: Prisma.AppEventUncheckedCreateInput) {
  const event = await db.appEvent.create({ data });
  createdEventIds.push(event.id);

  return event;
}

async function createLoginThrottle(data: Prisma.LoginThrottleCreateInput) {
  const loginThrottle = await db.loginThrottle.create({ data });
  createdLoginThrottleEmails.push(loginThrottle.email);

  return loginThrottle;
}

async function createAppSession(data: Prisma.AppSessionUncheckedCreateInput) {
  const appSession = await db.appSession.create({ data });
  createdAppSessionIds.push(appSession.id);

  return appSession;
}

async function createOpsAuditLog(data: Prisma.OpsAuditLogUncheckedCreateInput) {
  const auditLog = await db.opsAuditLog.create({ data });
  createdAuditLogIds.push(auditLog.id);

  return auditLog;
}

const emptyToday = {
  importConfirmed: 0,
  loginSuccess: 0,
  pageViews: 0,
  transactionCreated: 0,
  transactionDeleted: 0,
  transactionUpdated: 0,
};

describe("queryOpsDashboard", () => {
  it("aggregates counters, trend points, and privacy-safe recent events in Asia/Shanghai", async () => {
    const { household, husbandMember, husbandUser } = await createHouseholdFixture();

    await Promise.all([
      createAppEvent({
        createdAt: new Date("2035-05-07T16:20:00.000Z"),
        eventType: AppEventType.IMPORT_CONFIRMED,
        householdId: household.id,
        memberId: husbandMember.id,
        summary: "previous day import",
      }),
      createAppEvent({
        createdAt: new Date("2035-05-08T15:50:00.000Z"),
        eventType: AppEventType.PAGE_VIEW,
        householdId: household.id,
        memberId: husbandMember.id,
        path: "/records",
        summary: "previous shanghai day page view",
      }),
      createAppEvent({
        createdAt: new Date("2035-05-08T16:10:00.000Z"),
        eventType: AppEventType.LOGIN_SUCCESS,
        householdId: household.id,
        memberId: husbandMember.id,
        path: "/login",
        summary: "today login across shanghai boundary",
      }),
      createAppEvent({
        createdAt: new Date("2035-05-09T01:00:00.000Z"),
        eventType: AppEventType.PAGE_VIEW,
        householdId: household.id,
        memberId: husbandMember.id,
        path: "/home",
        summary: "today page view",
      }),
      createAppEvent({
        createdAt: new Date("2035-05-09T02:00:00.000Z"),
        eventType: AppEventType.TRANSACTION_CREATED,
        householdId: household.id,
        memberId: husbandMember.id,
        metadata: {
          amountFen: 12345,
          householdId: household.id,
          memberId: husbandMember.id,
          note: "private note",
          sourceFingerprint: "private-fingerprint",
        },
        summary: "today transaction created",
      }),
      createAppEvent({
        createdAt: new Date("2035-05-09T03:00:00.000Z"),
        eventType: AppEventType.TRANSACTION_UPDATED,
        householdId: household.id,
        memberId: husbandMember.id,
        summary: "today transaction updated",
      }),
      createAppEvent({
        createdAt: new Date("2035-05-09T04:00:00.000Z"),
        eventType: AppEventType.TRANSACTION_DELETED,
        householdId: household.id,
        memberId: husbandMember.id,
        summary: "today transaction deleted",
      }),
      createAppEvent({
        createdAt: new Date("2035-05-09T05:00:00.000Z"),
        eventType: AppEventType.IMPORT_CONFIRMED,
        householdId: household.id,
        memberId: husbandMember.id,
        summary: "today import confirmed",
      }),
      createAppEvent({
        createdAt: new Date("2035-05-09T06:00:00.000Z"),
        eventType: AppEventType.LOGIN_FAILED,
        path: "/login",
        summary: "today login failed without member",
      }),
      createLoginThrottle({
        attemptCount: 5,
        email: "person@example.com",
        lockedUntil: new Date("2035-05-09T10:15:00.000Z"),
      }),
      createLoginThrottle({
        attemptCount: 5,
        email: "expired@example.com",
        lockedUntil: new Date("2035-05-09T09:59:00.000Z"),
      }),
      createAppSession({
        expiresAt: new Date("2035-06-09T00:00:00.000Z"),
        lastSeenAt: new Date("2035-05-09T09:45:00.000Z"),
        loginAt: new Date("2035-05-09T09:30:00.000Z"),
        sessionKey: `ops-dashboard-session-${husbandUser.id}`,
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        userId: husbandUser.id,
      }),
      createOpsAuditLog({
        action: OpsAuditAction.RESET_USER_PASSWORD,
        createdAt: new Date("2035-05-09T09:50:00.000Z"),
        operator: "ops-admin",
        targetUserId: husbandUser.id,
      }),
    ]);

    const dashboard = await queryOpsDashboard({
      now: new Date("2035-05-09T10:00:00.000Z"),
      version: "1.4.0",
    });

    expect(dashboard.database).toEqual({ ok: true });
    expect(dashboard.status).toEqual({
      bindAddress: "127.0.0.1:32768",
      environment: process.env.NODE_ENV ?? "development",
      retentionDays: 90,
      version: "1.4.0",
    });
    expect(dashboard.today).toEqual({
      importConfirmed: 1,
      loginSuccess: 1,
      pageViews: 1,
      transactionCreated: 1,
      transactionDeleted: 1,
      transactionUpdated: 1,
    });
    expect(dashboard.blockedLogins).toHaveLength(1);
    expect(dashboard.blockedLogins[0]).toMatchObject({
      attemptCount: 5,
      emailLabel: "p***n@example.com",
      lockedUntil: new Date("2035-05-09T10:15:00.000Z"),
    });
    expect(dashboard.households).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          householdId: household.id,
          householdName: household.name,
          members: expect.arrayContaining([
            expect.objectContaining({
              email: husbandUser.email,
              memberId: husbandMember.id,
              memberName: husbandMember.memberName,
              sessions: [
                expect.objectContaining({
                  deviceLabel: "Chrome on Windows",
                  lastSeenAt: new Date("2035-05-09T09:45:00.000Z"),
                }),
              ],
              userId: husbandUser.id,
            }),
          ]),
        }),
      ]),
    );
    expect(dashboard.auditLogs[0]).toMatchObject({
      action: OpsAuditAction.RESET_USER_PASSWORD,
      operator: "ops-admin",
      targetSessionId: null,
      targetUserEmail: husbandUser.email,
      targetUserMemberName: husbandMember.memberName,
    });
    expect(JSON.stringify(dashboard.blockedLogins)).not.toContain("person@example.com");
    expect(dashboard.trend.map((point) => point.dayKey)).toEqual([
      "2035-05-03",
      "2035-05-04",
      "2035-05-05",
      "2035-05-06",
      "2035-05-07",
      "2035-05-08",
      "2035-05-09",
    ]);
    expect(dashboard.trend.find((point) => point.dayKey === "2035-05-08")).toMatchObject({
      keyActions: 1,
      loginSuccess: 0,
      pageViews: 1,
    });
    expect(dashboard.trend.find((point) => point.dayKey === "2035-05-09")).toMatchObject({
      keyActions: 4,
      loginSuccess: 1,
      pageViews: 1,
    });

    expect(dashboard.recentEvents[0]).toMatchObject({
      eventType: AppEventType.LOGIN_FAILED,
      memberName: null,
      path: "/login",
      summary: "today login failed without member",
    });

    const recentAction = dashboard.recentEvents.find(
      (event) => event.summary === "today transaction created",
    );

    expect(recentAction).toBeDefined();
    expect(recentAction).toMatchObject({
      eventType: AppEventType.TRANSACTION_CREATED,
      memberName: "Ops Husband",
      path: null,
      summary: "today transaction created",
    });
    expect(Object.keys(recentAction as Record<string, unknown>).sort()).toEqual([
      "createdAt",
      "eventType",
      "memberName",
      "path",
      "summary",
    ]);
  });

  it("returns empty dashboard data when the health check fails", async () => {
    vi.spyOn(db, "$queryRaw").mockRejectedValueOnce(
      new Error("postgresql://private-host:5432/private_db unavailable"),
    );
    const findManySpy = vi.spyOn(db.appEvent, "findMany");

    const dashboard = await queryOpsDashboard({
      now: new Date("2035-05-09T10:00:00.000Z"),
      version: "1.4.0",
    });

    expect(dashboard.database).toEqual({
      message: "Database connection failed",
      ok: false,
    });
    expect(dashboard.blockedLogins).toEqual([]);
    expect(dashboard.households).toEqual([]);
    expect(dashboard.auditLogs).toEqual([]);
    expect(findManySpy).not.toHaveBeenCalled();
    expect(dashboard.recentEvents).toEqual([]);
    expect(dashboard.today).toEqual(emptyToday);
    expect(dashboard.trend).toHaveLength(7);
    expect(
      dashboard.trend.every(
        (point) =>
          point.keyActions === 0 && point.loginSuccess === 0 && point.pageViews === 0,
      ),
    ).toBe(true);
  });
});
