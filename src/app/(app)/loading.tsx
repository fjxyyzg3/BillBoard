export default function AppLoading() {
  return (
    <section
      aria-busy="true"
      className="space-y-4"
      data-testid="app-route-loading"
    >
      <div aria-hidden="true" className="animate-pulse space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="h-7 w-24 rounded-lg bg-[var(--bb-skeleton)]" />
          <div className="h-11 w-36 rounded-xl bg-[var(--bb-skeleton)]" />
        </div>
        <div className="ios-panel space-y-4 p-4 sm:p-5">
          <div className="h-11 rounded-full bg-[var(--bb-skeleton)]" />
          <div className="h-16 rounded-2xl bg-[var(--bb-skeleton)]" />
          <div className="grid grid-cols-3 gap-2">
            <div className="h-10 rounded-full bg-[var(--bb-skeleton)]" />
            <div className="h-10 rounded-full bg-[var(--bb-skeleton)]" />
            <div className="h-10 rounded-full bg-[var(--bb-skeleton)]" />
          </div>
          <div className="h-12 rounded-2xl bg-[var(--bb-skeleton)]" />
          <div className="h-12 rounded-2xl bg-[var(--bb-skeleton)]" />
          <div className="h-14 rounded-2xl bg-[var(--bb-skeleton)]" />
        </div>
      </div>
    </section>
  );
}
