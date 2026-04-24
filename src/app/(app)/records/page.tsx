import { PerspectiveToggle } from "@/components/perspective-toggle";
import { TimeRangeSelector } from "@/components/time-range-selector";

export default function RecordsPage() {
  return (
    <section className="space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold">Records</h1>
          <p className="text-sm text-stone-500">History and editing will land in Task 6.</p>
        </div>
        <TimeRangeSelector />
      </header>
      <PerspectiveToggle />
      <div className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
        <p className="text-sm text-stone-600">
          Record filters now share the same range and perspective controls that later data queries
          will read from this page.
        </p>
      </div>
    </section>
  );
}
