import { AppEventType, type OpsAuditAction } from "@prisma/client";
import { describeSessionDevice } from "@/lib/auth/app-sessions";
import { physicalDb } from "@/lib/db";
import { canExposeAppEventBusiness } from "@/lib/ops/event-metadata";

const shanghaiOffsetMs = 8 * 60 * 60 * 1000;
const dayMs = 24 * 60 * 60 * 1000;
const appEventRetentionDays = 90;

type QueryOpsDashboardInput = {
  now?: Date;
  version: string;
};

type OpsDashboardToday = {
  importConfirmed: number;
  loginSuccess: number;
  pageViews: number;
  transactionCreated: number;
  transactionDeleted: number;
  transactionUpdated: number;
};

type OpsDashboardTrendPoint = {
  dayKey: string;
  keyActions: number;
  loginSuccess: number;
  pageViews: number;
};

type OpsDashboardRecentEvent = {
  createdAt: Date;
  eventType: AppEventType;
  memberName: string | null;
  path: string | null;
  summary: string | null;
};

type OpsDashboardBlockedLogin = {
  attemptCount: number;
  emailLabel: string;
  id: string;
  lockedUntil: Date;
  updatedAt: Date;
};

type OpsDashboardAppSession = {
  deviceLabel: string;
  expiresAt: Date;
  id: string;
  lastSeenAt: Date;
  loginAt: Date;
};

type OpsDashboardMemberAccount = {
  displayName: string;
  email: string;
  memberId: string;
  memberName: string;
  role: string;
  sessions: OpsDashboardAppSession[];
  status: string;
  userId: string;
};

type OpsDashboardHousehold = {
  householdId: string;
  householdName: string;
  members: OpsDashboardMemberAccount[];
};

type OpsDashboardAuditLog = {
  action: OpsAuditAction;
  createdAt: Date;
  id: string;
  operator: string;
  targetSessionId: string | null;
  targetAccessApplicationId: string | null;
  targetUserEmail: string | null;
  targetUserMemberName: string | null;
};

type OpsDashboardStatus = {
  bindAddress: "127.0.0.1:32768";
  environment: string;
  retentionDays: 90;
  version: string;
};

type OpsDashboardDatabase = { ok: true } | { message: string; ok: false };

export type OpsDashboard = {
  auditLogs: OpsDashboardAuditLog[];
  blockedLogins: OpsDashboardBlockedLogin[];
  database: OpsDashboardDatabase;
  households: OpsDashboardHousehold[];
  recentEvents: OpsDashboardRecentEvent[];
  status: OpsDashboardStatus;
  today: OpsDashboardToday;
  trend: OpsDashboardTrendPoint[];
};

const keyActionTypes = new Set<AppEventType>([
  AppEventType.IMPORT_CONFIRMED,
  AppEventType.TRANSACTION_CREATED,
  AppEventType.TRANSACTION_DELETED,
  AppEventType.TRANSACTION_UPDATED,
]);

export async function queryOpsDashboard({
  now = new Date(),
  version,
}: QueryOpsDashboardInput): Promise<OpsDashboard> {
  const status = createStatus(version);
  const todayStart = getShanghaiDayStartUtc(now);
  const trendStart = new Date(todayStart.getTime() - 6 * dayMs);
  const tomorrowStart = new Date(todayStart.getTime() + dayMs);

  try {
    await physicalDb.$queryRaw`SELECT 1`;

    const [
      eventRows,
      recentEventRows,
      blockedLoginRows,
      householdRows,
      auditLogRows,
    ] = await Promise.all([
      physicalDb.appEvent.findMany({
        where: {
          createdAt: {
            gte: trendStart,
            lt: tomorrowStart,
          },
        },
        select: {
          createdAt: true,
          eventType: true,
        },
      }),
      physicalDb.appEvent.findMany({
        orderBy: {
          createdAt: "desc",
        },
        select: {
          id: true,
          createdAt: true,
          eventType: true,
          encryptionRevision: true,
          household: { select: { encryption: { select: { mode: true, activeOperationId: true } } } },
          member: {
            select: {
              memberName: true,
            },
          },
          path: true,
        },
        take: 20,
      }),
      physicalDb.loginThrottle.findMany({
        orderBy: {
          lockedUntil: "desc",
        },
        select: {
          attemptCount: true,
          email: true,
          id: true,
          lockedUntil: true,
          updatedAt: true,
        },
        take: 10,
        where: {
          lockedUntil: {
            gt: now,
          },
        },
      }),
      physicalDb.household.findMany({
        orderBy: {
          createdAt: "asc",
        },
        select: {
          id: true,
          members: {
            where: { leftAt: null },
            orderBy: {
              joinedAt: "asc",
            },
            select: {
              id: true,
              memberName: true,
              role: true,
              user: {
                select: {
                  appSessions: {
                    orderBy: {
                      lastSeenAt: "desc",
                    },
                    select: {
                      expiresAt: true,
                      id: true,
                      lastSeenAt: true,
                      loginAt: true,
                      userAgent: true,
                    },
                    where: {
                      expiresAt: {
                        gt: now,
                      },
                      revokedAt: null,
                    },
                  },
                  displayName: true,
                  email: true,
                  id: true,
                  status: true,
                },
              },
            },
          },
          name: true,
        },
      }),
      physicalDb.opsAuditLog.findMany({
        orderBy: {
          createdAt: "desc",
        },
        select: {
          action: true,
          createdAt: true,
          id: true,
          operator: true,
          targetSessionId: true,
          targetAccessApplicationId: true,
          targetUser: {
            select: {
              email: true,
              householdMember: {
                where: { leftAt: null },
                select: {
                  memberName: true,
                },
              },
            },
          },
        },
        take: 50,
      }),
    ]);
    const visibleIds = recentEventRows.filter((event) => !event.encryptionRevision
      && canExposeAppEventBusiness(event.household?.encryption)).map((event) => event.id);
    const summaryRows = visibleIds.length ? await physicalDb.appEvent.findMany({
      where: {
        id: { in: visibleIds }, encryptedPayload: null,
        OR: [
          { householdId: null },
          { household: { is: { encryption: { is: null } } } },
          { household: { is: { encryption: { is: { mode: "UNENCRYPTED", activeOperationId: null } } } } },
        ],
      },
      select: { id: true, summary: true },
    }) : [];
    const summaries = new Map(summaryRows.map((event) => [event.id, event.summary]));

    return {
      auditLogs: auditLogRows.map((row) => ({
        action: row.action,
        createdAt: row.createdAt,
        id: row.id,
        operator: row.operator,
        targetSessionId: row.targetSessionId,
        targetAccessApplicationId: row.targetAccessApplicationId,
        targetUserEmail: row.targetUser?.email ?? null,
        targetUserMemberName: row.targetUser?.householdMember[0]?.memberName ?? null,
      })),
      blockedLogins: blockedLoginRows.flatMap((row) => {
        if (!row.lockedUntil) {
          return [];
        }

        return [
          {
            attemptCount: row.attemptCount,
            emailLabel: maskLoginEmail(row.email),
            id: row.id,
            lockedUntil: row.lockedUntil,
            updatedAt: row.updatedAt,
          },
        ];
      }),
      database: { ok: true },
      households: householdRows.map((household) => ({
        householdId: household.id,
        householdName: household.name,
        members: household.members.map((member) => ({
          displayName: member.user.displayName,
          email: member.user.email,
          memberId: member.id,
          memberName: member.memberName,
          role: member.role,
          sessions: member.user.appSessions.map((session) => ({
            deviceLabel: describeSessionDevice(session.userAgent),
            expiresAt: session.expiresAt,
            id: session.id,
            lastSeenAt: session.lastSeenAt,
            loginAt: session.loginAt,
          })),
          status: member.user.status,
          userId: member.user.id,
        })),
      })),
      recentEvents: recentEventRows.map((event) => ({
        createdAt: event.createdAt,
        eventType: event.eventType,
        memberName: event.member?.memberName ?? null,
        path: event.path,
        summary: summaries.get(event.id) ?? null,
      })),
      status,
      today: aggregateToday(eventRows, todayStart, tomorrowStart),
      trend: aggregateTrend(eventRows, now),
    };
  } catch {
    return {
      auditLogs: [],
      blockedLogins: [],
      database: {
        message: "Database connection failed",
        ok: false,
      },
      households: [],
      recentEvents: [],
      status,
      today: createEmptyToday(),
      trend: createEmptyTrend(now),
    };
  }
}

function createStatus(version: string): OpsDashboardStatus {
  return {
    bindAddress: "127.0.0.1:32768",
    environment: process.env.NODE_ENV ?? "development",
    retentionDays: appEventRetentionDays,
    version,
  };
}

function maskLoginEmail(email: string) {
  const [localPart, domainPart] = email.split("@");

  if (!localPart || !domainPart) {
    return "hidden";
  }

  const first = localPart.slice(0, 1);
  const last = localPart.length > 1 ? localPart.slice(-1) : "";

  return `${first}***${last}@${domainPart}`;
}

function aggregateToday(
  events: Array<{ createdAt: Date; eventType: AppEventType }>,
  todayStart: Date,
  tomorrowStart: Date,
) {
  const today = createEmptyToday();

  for (const event of events) {
    if (event.createdAt < todayStart || event.createdAt >= tomorrowStart) {
      continue;
    }

    incrementTodayCounter(today, event.eventType);
  }

  return today;
}

function aggregateTrend(
  events: Array<{ createdAt: Date; eventType: AppEventType }>,
  now: Date,
) {
  const trend = createEmptyTrend(now);
  const trendByDay = new Map(trend.map((point) => [point.dayKey, point]));

  for (const event of events) {
    const point = trendByDay.get(getShanghaiDayKey(event.createdAt));

    if (!point) {
      continue;
    }

    if (event.eventType === AppEventType.LOGIN_SUCCESS) {
      point.loginSuccess += 1;
    } else if (event.eventType === AppEventType.PAGE_VIEW) {
      point.pageViews += 1;
    } else if (keyActionTypes.has(event.eventType)) {
      point.keyActions += 1;
    }
  }

  return trend;
}

function createEmptyToday(): OpsDashboardToday {
  return {
    importConfirmed: 0,
    loginSuccess: 0,
    pageViews: 0,
    transactionCreated: 0,
    transactionDeleted: 0,
    transactionUpdated: 0,
  };
}

function createEmptyTrend(now: Date): OpsDashboardTrendPoint[] {
  const todayStart = getShanghaiDayStartUtc(now);

  return Array.from({ length: 7 }, (_, index) => {
    const dayStart = new Date(todayStart.getTime() - (6 - index) * dayMs);

    return {
      dayKey: getShanghaiDayKey(dayStart),
      keyActions: 0,
      loginSuccess: 0,
      pageViews: 0,
    };
  });
}

function incrementTodayCounter(today: OpsDashboardToday, eventType: AppEventType) {
  if (eventType === AppEventType.IMPORT_CONFIRMED) {
    today.importConfirmed += 1;
  } else if (eventType === AppEventType.LOGIN_SUCCESS) {
    today.loginSuccess += 1;
  } else if (eventType === AppEventType.PAGE_VIEW) {
    today.pageViews += 1;
  } else if (eventType === AppEventType.TRANSACTION_CREATED) {
    today.transactionCreated += 1;
  } else if (eventType === AppEventType.TRANSACTION_DELETED) {
    today.transactionDeleted += 1;
  } else if (eventType === AppEventType.TRANSACTION_UPDATED) {
    today.transactionUpdated += 1;
  }
}

function getShanghaiDayStartUtc(date: Date) {
  return new Date(Date.parse(`${getShanghaiDayKey(date)}T00:00:00.000Z`) - shanghaiOffsetMs);
}

function getShanghaiDayKey(date: Date) {
  return new Date(date.getTime() + shanghaiOffsetMs).toISOString().slice(0, 10);
}
