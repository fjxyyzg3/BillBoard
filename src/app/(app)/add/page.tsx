export default function AddPage() {
  return (
    <section className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">Add</h1>
        <p className="text-sm text-stone-500">Fast entry form will land in Task 5.</p>
      </header>
      <div className="rounded-2xl border border-dashed border-stone-300 bg-white p-6">
        <p className="text-sm text-stone-600">
          This route now lives inside the authenticated app shell so transaction entry can arrive
          without more navigation work later.
        </p>
      </div>
    </section>
  );
}
