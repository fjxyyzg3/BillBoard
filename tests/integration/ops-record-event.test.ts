import { existsSync } from "node:fs";

if (existsSync(".env")) {
  process.loadEnvFile?.(".env");
}

if (existsSync(".env.example")) {
  process.loadEnvFile?.(".env.example");
}

import { AppEventType } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

let db: typeof import("@/lib/db").physicalDb;
let recordAppEvent: typeof import("@/lib/ops/record-event").recordAppEvent;

const createdEventIds: string[] = [];
const possibleUnexpectedEventCleanupKeys: Array<{
  createdAt: Date;
  eventType: AppEventType;
}> = [];
let uniqueDateSequence = 0;

beforeAll(async () => {
  assertSafeTestDatabase();
  ({ physicalDb: db } = await import("@/lib/db"));
  ({ recordAppEvent } = await import("@/lib/ops/record-event"));
});

afterEach(async () => {
  vi.restoreAllMocks();

  if (createdEventIds.length > 0) {
    await db.appEvent.deleteMany({
      where: { id: { in: createdEventIds.splice(0, createdEventIds.length) } },
    });
  }

  const cleanupKeys = possibleUnexpectedEventCleanupKeys.splice(
    0,
    possibleUnexpectedEventCleanupKeys.length,
  );

  if (cleanupKeys.length > 0) {
    await db.appEvent.deleteMany({
      where: {
        OR: cleanupKeys.map(({ createdAt, eventType }) => ({
          createdAt,
          eventType,
        })),
      },
    });
  }
});

afterAll(async () => {
  await db.$disconnect();
});

function assertSafeTestDatabase() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Ops record event integration tests must not run with NODE_ENV=production");
  }

  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for ops record event integration tests");
  }

  const parsedUrl = new URL(databaseUrl);
  const databaseName = parsedUrl.pathname.replace(/^\//, "");
  const hostIsLocal = parsedUrl.hostname === "127.0.0.1" || parsedUrl.hostname === "localhost";
  const databaseIsDevOrTest = /(?:dev|test)/i.test(databaseName);

  if (!hostIsLocal || !databaseIsDevOrTest) {
    throw new Error("Refusing to run ops record event integration tests against a non-dev/test database");
  }
}

function nextUniqueEventDate() {
  uniqueDateSequence += 1;

  return new Date(Date.now() + uniqueDateSequence);
}

describe("recordAppEvent", () => {
  it("writes sanitized metadata and removes events older than 90 days", async () => {
    const now = nextUniqueEventDate();
    const oldEvent = await db.appEvent.create({
      data: {
        eventType: AppEventType.PAGE_VIEW,
        summary: "old app event",
        createdAt: new Date(now.getTime() - 91 * 24 * 60 * 60 * 1000),
      },
    });
    createdEventIds.push(oldEvent.id);

    await recordAppEvent({
      eventType: AppEventType.IMPORT_CONFIRMED,
      metadata: { count: 3, source: "alipay" },
      now,
      summary: "确认导入 3 笔",
    });

    const created = await db.appEvent.findFirstOrThrow({
      where: {
        createdAt: now,
        eventType: AppEventType.IMPORT_CONFIRMED,
      },
    });
    createdEventIds.push(created.id);

    expect(created.metadata).toEqual({ count: 3, source: "alipay" });
    expect(created.summary).toBe("确认导入 3 笔");
    await expect(
      db.appEvent.findUnique({ where: { id: oldEvent.id } }),
    ).resolves.toBeNull();
  });

  it("does not throw when the database write fails", async () => {
    vi.spyOn(db, "$transaction").mockRejectedValueOnce(
      new Error("database unavailable"),
    );

    await expect(
      recordAppEvent({
        eventType: AppEventType.PAGE_VIEW,
        path: "/home",
        summary: "访问 首页",
      }),
    ).resolves.toBeUndefined();
  });

  it("does not persist an event when metadata is unsupported", async () => {
    const now = nextUniqueEventDate();
    possibleUnexpectedEventCleanupKeys.push({
      createdAt: now,
      eventType: AppEventType.PAGE_VIEW,
    });

    await expect(
      recordAppEvent({
        eventType: AppEventType.PAGE_VIEW,
        metadata: { source: "account-123" } as any,
        now,
        summary: "访问 首页",
      }),
    ).resolves.toBeUndefined();

    await expect(
      db.appEvent.findFirst({
        where: {
          createdAt: now,
          eventType: AppEventType.PAGE_VIEW,
        },
      }),
    ).resolves.toBeNull();
  });

  it("persists sanitized path and allowed summary", async () => {
    const now = nextUniqueEventDate();

    await recordAppEvent({
      eventType: AppEventType.PAGE_VIEW,
      now,
      path: "/records?record=secret",
      summary: "访问 记录",
    });

    const created = await db.appEvent.findFirstOrThrow({
      where: {
        createdAt: now,
        eventType: AppEventType.PAGE_VIEW,
      },
    });
    createdEventIds.push(created.id);

    expect(created.path).toBe("/records");
    expect(created.summary).toBe("访问 记录");
  });

  it("does not persist an event when path is unsupported", async () => {
    const now = nextUniqueEventDate();
    possibleUnexpectedEventCleanupKeys.push({
      createdAt: now,
      eventType: AppEventType.PAGE_VIEW,
    });

    await expect(
      recordAppEvent({
        eventType: AppEventType.PAGE_VIEW,
        now,
        path: "/unsafe?token=secret",
        summary: "访问 记录",
      }),
    ).resolves.toBeUndefined();

    await expect(
      db.appEvent.findFirst({
        where: {
          createdAt: now,
          eventType: AppEventType.PAGE_VIEW,
        },
      }),
    ).resolves.toBeNull();
  });

  it("does not persist an event when summary is unsupported", async () => {
    const now = nextUniqueEventDate();
    possibleUnexpectedEventCleanupKeys.push({
      createdAt: now,
      eventType: AppEventType.PAGE_VIEW,
    });

    await expect(
      recordAppEvent({
        eventType: AppEventType.PAGE_VIEW,
        now,
        summary: "备注 private note",
      }),
    ).resolves.toBeUndefined();

    await expect(
      db.appEvent.findFirst({
        where: {
          createdAt: now,
          eventType: AppEventType.PAGE_VIEW,
        },
      }),
    ).resolves.toBeNull();
  });
});
