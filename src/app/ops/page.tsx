import { AppEventType, OpsAuditAction } from "@prisma/client";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import packageJson from "../../../package.json";
import {
  logoutOpsAdmin,
  releaseLoginThrottle,
  resetUserPassword,
  revokeAppSession,
  submitOpsAdminLogin,
  getPlatformInvitationsForOps,
  createPlatformInvitationAction,
  revokePlatformInvitationAction,
  getAccessApplicationsForOps,
} from "@/app/ops/actions";
import { IdentityField, IdentityForm } from "@/components/identity-form";
import { IdentityInvitations } from "@/components/identity-invitations";
import { OpsAccessApplications } from "@/components/ops-access-applications";
import {
  formatLocaleDateTime,
  formatLocaleNumber,
  getMessages,
  type Locale,
  type Messages,
} from "@/lib/i18n";
import { getServerLocale } from "@/lib/i18n-server";
import {
  opsAdminSessionCookieName,
  verifyOpsAdminSessionToken,
} from "@/lib/ops/auth";
import { getOpsAdminConfig } from "@/lib/ops/config";
import { queryOpsDashboard, type OpsDashboard } from "@/lib/ops/dashboard";

type OpsMessages = Messages["ops"];

function getOpsSessionSecret() {
  if (process.env.AUTH_SECRET) {
    return process.env.AUTH_SECRET;
  }

  return process.env.NODE_ENV === "production" ? "" : "development-auth-secret";
}

export default async function OpsPage({ searchParams }: { searchParams?: Promise<{ applicationsPage?: string | string[] }> } = {}) {
  const config = getOpsAdminConfig();

  if (!config.instance) {
    notFound();
  }

  const locale = await getServerLocale();
  const messages = getMessages(locale);
  const labels = messages.ops;

  if (!config.enabled) {
    return (
      <OpsShell labels={labels}>
        <ConfigurationPanel description={labels.description} title={labels.disabled} />
      </OpsShell>
    );
  }

  if (!config.hasPasswordHash) {
    return (
      <OpsShell labels={labels}>
        <ConfigurationPanel
          description={labels.description}
          title={labels.missingPasswordHash}
        />
      </OpsShell>
    );
  }

  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(opsAdminSessionCookieName)?.value;
  const isAuthenticated = verifyOpsAdminSessionToken(
    sessionToken,
    getOpsSessionSecret(),
  );

  if (!isAuthenticated) {
    return (
      <OpsShell labels={labels}>
        <LoginPanel labels={labels} locale={locale} />
      </OpsShell>
    );
  }

  const requestedPage = (await searchParams)?.applicationsPage;
  const parsedPage = typeof requestedPage === "string" && /^\d+$/.test(requestedPage) ? Number(requestedPage) : 1;
  const applicationsPage = Number.isSafeInteger(parsedPage) && parsedPage > 0 && parsedPage <= 1_000 ? parsedPage : 1;
  const [dashboard, platformInvitations, accessApplications] = await Promise.all([
    queryOpsDashboard({ version: packageJson.version }),
    getPlatformInvitationsForOps(),
    getAccessApplicationsForOps(applicationsPage),
  ]);
  // Request-time display only; invitation actions always recheck expiry on the server.
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-5 px-4 py-5 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <h1 className="text-2xl font-medium text-[var(--ios-text)]">
            {labels.title}
          </h1>
          <p className="max-w-2xl text-sm text-[var(--ios-muted)]">
            {labels.description}
          </p>
        </div>
        <form action={logoutOpsAdmin}>
          <button
            className="inline-flex min-h-11 items-center justify-center rounded-xl border border-[var(--bb-warm-line)] bg-white px-4 text-sm font-medium text-[var(--bb-ink)] shadow-sm transition hover:bg-[var(--bb-warm-surface)]"
            type="submit"
          >
            {labels.logout}
          </button>
        </form>
      </header>

      <OpsAccessApplications applications={accessApplications} locale={locale} page={applicationsPage} />

      <section className="ios-panel p-4 sm:p-5">
        <h2 className="text-base font-medium">{messages.identity.platformInvitationsTitle}</h2>
        <p className="mb-4 mt-2 text-sm leading-6 text-[var(--bb-muted)]">{messages.identity.platformInvitationsHelp}</p>
        <div className="grid items-start gap-6 md:grid-cols-2">
          <IdentityForm action={createPlatformInvitationAction} labels={messages.identity} refresh submitLabel={messages.identity.sendInvitation}>
            <input name="locale" type="hidden" value={locale} />
            <IdentityField autoComplete="email" label={messages.identity.invitedEmail} maxLength={254} name="email" type="email" />
          </IdentityForm>
          <IdentityInvitations action={revokePlatformInvitationAction} empty={messages.identity.noPlatformInvitations} invitations={platformInvitations.map((entry) => ({ ...entry, expiresAt: entry.expiresAt.toISOString(), sentAt: entry.sentAt?.toISOString() ?? null, consumedAt: entry.consumedAt?.toISOString() ?? null, revokedAt: entry.revokedAt?.toISOString() ?? null }))} labels={messages.identity} locale={locale} now={now} />
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <StatusTile label={labels.status.appOnline} value={labels.status.databaseConnected} />
        <StatusTile
          label={labels.status.database}
          value={
            dashboard.database.ok
              ? labels.status.databaseConnected
              : labels.status.databaseFailed
          }
          tone={dashboard.database.ok ? "default" : "danger"}
        />
        <StatusTile
          label={labels.status.todayLogins}
          value={formatLocaleNumber(dashboard.today.loginSuccess, locale)}
        />
        <StatusTile
          label={labels.status.todayPageViews}
          value={formatLocaleNumber(dashboard.today.pageViews, locale)}
        />
        <StatusTile
          label={labels.status.blockedLogins}
          tone={dashboard.blockedLogins.length > 0 ? "danger" : "default"}
          value={formatLocaleNumber(dashboard.blockedLogins.length, locale)}
        />
      </section>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(20rem,0.9fr)]">
        <TrendPanel dashboard={dashboard} labels={labels} locale={locale} />
        <TodayActionsPanel dashboard={dashboard} labels={labels} locale={locale} />
      </section>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(20rem,0.8fr)]">
        <UserSessionsPanel dashboard={dashboard} labels={labels} locale={locale} />
        <SecurityAuditPanel dashboard={dashboard} labels={labels} locale={locale} />
      </section>

      <section className="grid gap-4 xl:grid-cols-[minmax(20rem,0.85fr)_minmax(20rem,0.85fr)_minmax(0,1.25fr)]">
        <RuntimePanel dashboard={dashboard} labels={labels} />
        <BlockedLoginsPanel dashboard={dashboard} labels={labels} locale={locale} />
        <RecentEventsPanel dashboard={dashboard} labels={labels} locale={locale} />
      </section>
    </main>
  );
}

function OpsShell({
  children,
  labels,
}: {
  children: React.ReactNode;
  labels: OpsMessages;
}) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-5 px-4 py-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-medium text-[var(--ios-text)]">
          {labels.title}
        </h1>
        <p className="text-sm text-[var(--ios-muted)]">{labels.description}</p>
      </header>
      {children}
    </main>
  );
}

function ConfigurationPanel({
  description,
  title,
}: {
  description: string;
  title: string;
}) {
  return (
    <section className="ios-panel p-5">
      <h2 className="text-base font-medium text-[var(--ios-text)]">{title}</h2>
      <p className="mt-2 text-sm leading-6 text-[var(--ios-muted)]">{description}</p>
    </section>
  );
}

function LoginPanel({ labels, locale }: { labels: OpsMessages; locale: Locale }) {
  return (
    <form action={submitOpsAdminLogin} className="ios-panel space-y-4 p-5">
      <input name="locale" type="hidden" value={locale} />
      <label className="block space-y-2">
        <span className="text-sm font-medium text-[var(--bb-ink)]">{labels.password}</span>
        <input
          autoComplete="current-password"
          className="ios-field"
          name="password"
          required
          type="password"
        />
      </label>
      <button
        className="inline-flex min-h-11 w-full items-center justify-center rounded-xl bg-[var(--ios-blue)] px-4 text-sm font-medium text-white shadow-sm transition hover:bg-[var(--bb-primary-hover)]"
        type="submit"
      >
        {labels.login}
      </button>
    </form>
  );
}

function StatusTile({
  label,
  tone = "default",
  value,
}: {
  label: string;
  tone?: "danger" | "default";
  value: string;
}) {
  return (
    <div className="ios-panel p-4">
      <p className="text-xs font-medium text-[var(--ios-muted)]">{label}</p>
      <p
        className={`mt-2 text-2xl font-medium tabular-nums ${
          tone === "danger" ? "text-[var(--ios-red)]" : "text-[var(--ios-text)]"
        }`}
      >
        {value}
      </p>
    </div>
  );
}

function TrendPanel({
  dashboard,
  labels,
  locale,
}: {
  dashboard: OpsDashboard;
  labels: OpsMessages;
  locale: Locale;
}) {
  const maxTotal = Math.max(
    1,
    ...dashboard.trend.map(
      (point) => point.keyActions + point.loginSuccess + point.pageViews,
    ),
  );

  return (
    <section className="ios-panel p-4 sm:p-5">
      <PanelTitle
        detail={labels.eventsRetainedDays(dashboard.status.retentionDays)}
        title={labels.trendTitle}
      />
      <div className="mt-4 space-y-3">
        {dashboard.trend.map((point) => {
          const total = point.keyActions + point.loginSuccess + point.pageViews;
          const width = `${Math.max(4, Math.round((total / maxTotal) * 100))}%`;

          return (
            <div className="grid grid-cols-[5.75rem_minmax(0,1fr)_3rem] items-center gap-3" key={point.dayKey}>
              <span className="text-xs tabular-nums text-[var(--ios-muted)]">
                {point.dayKey.slice(5)}
              </span>
              <div className="h-1.5 overflow-hidden rounded-full bg-[var(--bb-warm-surface)]">
                <div
                  className="h-full rounded-full bg-[var(--ios-blue)]"
                  style={{ width }}
                />
              </div>
              <span className="text-right text-xs font-medium tabular-nums text-[var(--bb-muted)]">
                {formatLocaleNumber(total, locale)}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function TodayActionsPanel({
  dashboard,
  labels,
  locale,
}: {
  dashboard: OpsDashboard;
  labels: OpsMessages;
  locale: Locale;
}) {
  const items = [
    [labels.actions.importConfirmed, dashboard.today.importConfirmed],
    [labels.actions.transactionCreated, dashboard.today.transactionCreated],
    [labels.actions.transactionUpdated, dashboard.today.transactionUpdated],
    [labels.actions.transactionDeleted, dashboard.today.transactionDeleted],
  ] as const;

  return (
    <section className="ios-panel p-4 sm:p-5">
      <PanelTitle title={labels.todayActionsTitle} />
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3">
        {items.map(([label, value]) => (
          <div className="min-w-0" key={label}>
            <dt className="truncate text-xs text-[var(--ios-muted)]">{label}</dt>
            <dd className="mt-1 text-xl font-medium tabular-nums text-[var(--ios-text)]">
              {formatLocaleNumber(value, locale)}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function UserSessionsPanel({
  dashboard,
  labels,
  locale,
}: {
  dashboard: OpsDashboard;
  labels: OpsMessages;
  locale: Locale;
}) {
  return (
    <section className="ios-panel overflow-hidden">
      <div className="p-4 sm:p-5">
        <PanelTitle title={labels.userSessionsTitle} />
      </div>
      {dashboard.households.length === 0 ? (
        <p className="border-t border-[var(--bb-warm-line)] p-4 text-sm text-[var(--ios-muted)] sm:p-5">
          {labels.users.noActiveSessions}
        </p>
      ) : (
        <div className="divide-y divide-[var(--bb-warm-line)]">
          {dashboard.households.map((household) => (
            <div className="space-y-4 p-4 sm:p-5" key={household.householdId}>
              <h3 className="text-sm font-medium text-[var(--ios-text)]">
                {household.householdName}
              </h3>
              <div className="space-y-4">
                {household.members.map((member) => (
                  <div
                    className="grid gap-4 rounded-xl border border-[var(--bb-warm-line)] p-3 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.25fr)]"
                    key={member.memberId}
                  >
                    <div className="min-w-0 space-y-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-[var(--ios-text)]">
                          {member.memberName}
                        </p>
                        <p className="mt-1 truncate text-xs text-[var(--ios-muted)]">
                          {member.email}
                        </p>
                      </div>
                      <dl className="grid grid-cols-2 gap-2 text-xs">
                        <div>
                          <dt className="text-[var(--ios-muted)]">{labels.users.status}</dt>
                          <dd className="mt-0.5 font-medium text-[var(--ios-text)]">
                            {member.status}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-[var(--ios-muted)]">{labels.users.activeSessions}</dt>
                          <dd className="mt-0.5 font-medium tabular-nums text-[var(--ios-text)]">
                            {formatLocaleNumber(member.sessions.length, locale)}
                          </dd>
                        </div>
                      </dl>
                      <form action={resetUserPassword} className="grid gap-2">
                        <input name="userId" type="hidden" value={member.userId} />
                        <label className="grid gap-1">
                          <span className="text-xs font-medium text-[var(--bb-ink)]">
                            {labels.users.newPassword}
                          </span>
                          <input
                            autoComplete="new-password"
                            className="ios-field min-h-10 text-sm"
                            minLength={8}
                            name="newPassword"
                            required
                            type="password"
                          />
                        </label>
                        <label className="grid gap-1">
                          <span className="text-xs font-medium text-[var(--bb-ink)]">
                            {labels.users.confirmPassword}
                          </span>
                          <input
                            autoComplete="new-password"
                            className="ios-field min-h-10 text-sm"
                            minLength={8}
                            name="confirmPassword"
                            required
                            type="password"
                          />
                        </label>
                        <label className="flex items-start gap-2 text-xs leading-5 text-[var(--ios-muted)]">
                          <input
                            className="mt-1 h-4 w-4 rounded border-stone-300"
                            name="confirmReset"
                            required
                            type="checkbox"
                          />
                          <span>{labels.users.confirmReset}</span>
                        </label>
                        <button
                          className="inline-flex min-h-11 items-center justify-center rounded-xl bg-[var(--bb-primary)] px-3 text-xs font-medium text-white transition hover:bg-[var(--bb-primary-hover)]"
                          type="submit"
                        >
                          {labels.users.resetPassword}
                        </button>
                      </form>
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-[var(--ios-muted)]">
                        {labels.users.activeSessions}
                      </p>
                      {member.sessions.length === 0 ? (
                        <p className="mt-3 text-sm text-[var(--ios-muted)]">
                          {labels.users.noActiveSessions}
                        </p>
                      ) : (
                        <ul className="mt-3 divide-y divide-[var(--bb-warm-line)] rounded-xl border border-[var(--bb-warm-line)]">
                          {member.sessions.map((session) => (
                            <li className="p-3" key={session.id}>
                              <div className="flex min-w-0 items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <p className="truncate text-sm font-medium text-[var(--ios-text)]">
                                    {session.deviceLabel}
                                  </p>
                                  <dl className="mt-2 grid gap-1 text-xs text-[var(--ios-muted)]">
                                    <div className="flex min-w-0 justify-between gap-3">
                                      <dt>{labels.users.loginAt}</dt>
                                      <dd className="text-right tabular-nums">
                                        {formatLocaleDateTime(session.loginAt, locale)}
                                      </dd>
                                    </div>
                                    <div className="flex min-w-0 justify-between gap-3">
                                      <dt>{labels.users.lastSeenAt}</dt>
                                      <dd className="text-right tabular-nums">
                                        {formatLocaleDateTime(session.lastSeenAt, locale)}
                                      </dd>
                                    </div>
                                    <div className="flex min-w-0 justify-between gap-3">
                                      <dt>{labels.users.expiresAt}</dt>
                                      <dd className="text-right tabular-nums">
                                        {formatLocaleDateTime(session.expiresAt, locale)}
                                      </dd>
                                    </div>
                                  </dl>
                                </div>
                                <form action={revokeAppSession}>
                                  <input name="appSessionId" type="hidden" value={session.id} />
                                  <button
                                    className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-xl bg-[var(--ios-red)] px-3 text-xs font-medium text-white transition hover:bg-red-600"
                                    type="submit"
                                  >
                                    {labels.users.revokeSession}
                                  </button>
                                </form>
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function SecurityAuditPanel({
  dashboard,
  labels,
  locale,
}: {
  dashboard: OpsDashboard;
  labels: OpsMessages;
  locale: Locale;
}) {
  return (
    <section className="ios-panel overflow-hidden">
      <div className="p-4 sm:p-5">
        <PanelTitle title={labels.securityAuditTitle} />
      </div>
      {dashboard.auditLogs.length === 0 ? (
        <p className="border-t border-[var(--bb-warm-line)] p-4 text-sm text-[var(--ios-muted)] sm:p-5">
          {labels.emptyAuditLogs}
        </p>
      ) : (
        <ul className="divide-y divide-[var(--bb-warm-line)]">
          {dashboard.auditLogs.map((log) => (
            <li className="px-4 py-3 sm:px-5" key={log.id}>
              <div className="flex min-w-0 items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-[var(--ios-text)]">
                    {getAuditActionLabel(log.action, labels)}
                  </p>
                  <p className="mt-1 truncate text-xs text-[var(--ios-muted)]">
                    {[log.targetUserMemberName, log.targetUserEmail, log.targetSessionId, log.targetAccessApplicationId]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <time className="shrink-0 text-right text-xs tabular-nums text-[var(--ios-muted)]">
                  {formatLocaleDateTime(log.createdAt, locale)}
                </time>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RuntimePanel({
  dashboard,
  labels,
}: {
  dashboard: OpsDashboard;
  labels: OpsMessages;
}) {
  const items = [
    [labels.runtime.version, dashboard.status.version],
    [labels.runtime.retentionDays, String(dashboard.status.retentionDays)],
    [labels.runtime.bindAddress, dashboard.status.bindAddress],
    [labels.runtime.environment, dashboard.status.environment],
  ] as const;

  return (
    <section className="ios-panel p-4 sm:p-5">
      <PanelTitle title={labels.runtimeTitle} />
      <dl className="mt-4 space-y-3">
        {items.map(([label, value]) => (
          <div className="flex min-w-0 items-center justify-between gap-4" key={label}>
            <dt className="text-sm text-[var(--ios-muted)]">{label}</dt>
            <dd className="min-w-0 truncate text-right text-sm font-medium text-[var(--ios-text)]">
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function BlockedLoginsPanel({
  dashboard,
  labels,
  locale,
}: {
  dashboard: OpsDashboard;
  labels: OpsMessages;
  locale: Locale;
}) {
  return (
    <section className="ios-panel overflow-hidden">
      <div className="p-4 sm:p-5">
        <PanelTitle title={labels.blockedLoginsTitle} />
        <p className="mt-2 text-xs leading-5 text-[var(--ios-muted)]">
          {labels.blockedLoginsDescription}
        </p>
      </div>
      {dashboard.blockedLogins.length === 0 ? (
        <p className="border-t border-[var(--bb-warm-line)] p-4 text-sm text-[var(--ios-muted)] sm:p-5">
          {labels.emptyBlockedLogins}
        </p>
      ) : (
        <ul className="divide-y divide-[var(--bb-warm-line)]">
          {dashboard.blockedLogins.map((blockedLogin) => (
            <li className="px-4 py-3 sm:px-5" key={blockedLogin.id}>
              <div className="flex min-w-0 items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-[var(--ios-text)]">
                    {blockedLogin.emailLabel}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-[var(--ios-muted)]">
                    {labels.blockedLoginMeta(
                      formatLocaleNumber(blockedLogin.attemptCount, locale),
                      formatLocaleDateTime(blockedLogin.lockedUntil, locale),
                    )}
                  </p>
                </div>
                <form action={releaseLoginThrottle}>
                  <input
                    name="loginThrottleId"
                    type="hidden"
                    value={blockedLogin.id}
                  />
                  <button
                    className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-xl bg-[var(--bb-primary)] px-3 text-xs font-medium text-white transition hover:bg-[var(--bb-primary-hover)]"
                    type="submit"
                  >
                    {labels.releaseBlockedLogin}
                  </button>
                </form>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RecentEventsPanel({
  dashboard,
  labels,
  locale,
}: {
  dashboard: OpsDashboard;
  labels: OpsMessages;
  locale: Locale;
}) {
  return (
    <section className="ios-panel overflow-hidden">
      <div className="p-4 sm:p-5">
        <PanelTitle title={labels.recentTitle} />
      </div>
      {dashboard.recentEvents.length === 0 ? (
        <p className="border-t border-[var(--bb-warm-line)] p-4 text-sm text-[var(--ios-muted)] sm:p-5">
          {labels.emptyRecentEvents}
        </p>
      ) : (
        <ul className="divide-y divide-[var(--bb-warm-line)]">
          {dashboard.recentEvents.map((event) => (
            <li className="px-4 py-3 sm:px-5" key={`${event.createdAt.toISOString()}-${event.eventType}`}>
              <div className="flex min-w-0 items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-[var(--ios-text)]">
                    {getEventLabel(event.eventType, labels)}
                  </p>
                  <p className="mt-1 truncate text-xs text-[var(--ios-muted)]">
                    {[event.summary, event.path, event.memberName].filter(Boolean).join(" · ")}
                  </p>
                </div>
                <time className="shrink-0 text-right text-xs tabular-nums text-[var(--ios-muted)]">
                  {formatLocaleDateTime(event.createdAt, locale)}
                </time>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PanelTitle({ detail, title }: { detail?: string; title: string }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3">
      <h2 className="text-base font-medium text-[var(--ios-text)]">{title}</h2>
      {detail ? (
        <p className="truncate text-xs text-[var(--ios-muted)]">{detail}</p>
      ) : null}
    </div>
  );
}

function getAuditActionLabel(action: OpsAuditAction, labels: OpsMessages) {
  return labels.auditActions[action] ?? String(action).replaceAll("_", " ");
}

function getEventLabel(
  eventType: OpsDashboard["recentEvents"][number]["eventType"],
  labels: OpsMessages,
) {
  if (eventType === AppEventType.IMPORT_CONFIRMED) {
    return labels.actions.importConfirmed;
  }

  if (eventType === AppEventType.IMPORT_DRAFT_UPLOADED) {
    return labels.actions.importDraftUploaded;
  }

  if (eventType === AppEventType.LOGIN_FAILED) {
    return labels.actions.loginFailed;
  }

  if (eventType === AppEventType.LOGIN_SUCCESS) {
    return labels.actions.loginSuccess;
  }

  if (eventType === AppEventType.PAGE_VIEW) {
    return labels.actions.pageView;
  }

  if (eventType === AppEventType.TRANSACTION_CREATED) {
    return labels.actions.transactionCreated;
  }

  if (eventType === AppEventType.TRANSACTION_DELETED) {
    return labels.actions.transactionDeleted;
  }

  if (eventType === AppEventType.TRANSACTION_UPDATED) {
    return labels.actions.transactionUpdated;
  }

  return String(eventType).replaceAll("_", " ");
}
