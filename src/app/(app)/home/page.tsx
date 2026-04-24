import { PerspectiveToggle } from "@/components/perspective-toggle";
import { TimeRangeSelector } from "@/components/time-range-selector";

export default function HomePage() {
  return (
    <section className="space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold">Home</h1>
          <p className="text-sm text-stone-500">Dashboard reporting will land in Task 7.</p>
        </div>
        <TimeRangeSelector />
      </header>
      <PerspectiveToggle />
      <div className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
        <p className="text-sm text-stone-600">
          Shared app navigation and filter state are in place, so the dashboard can plug into the
          selected range and perspective in the next reporting task.
        </p>
      </div>
    </section>
  );
}
