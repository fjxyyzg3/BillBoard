"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { parsePerspective, type Perspective } from "@/lib/perspective";

const items: Array<{ value: Perspective; label: string }> = [
  { value: "household", label: "Household" },
  { value: "me", label: "Me" },
  { value: "spouse", label: "Spouse" },
];

export function PerspectiveToggle() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const perspective = parsePerspective(searchParams.get("perspective"));

  function setPerspective(nextPerspective: Perspective) {
    const params = new URLSearchParams(searchParams.toString());

    if (nextPerspective === "household") {
      params.delete("perspective");
    } else {
      params.set("perspective", nextPerspective);
    }

    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  return (
    <div className="inline-grid grid-cols-3 rounded-2xl bg-stone-100 p-1 text-sm">
      {items.map((item) => {
        const isActive = perspective === item.value;

        return (
          <button
            aria-pressed={isActive}
            className={`rounded-xl px-3 py-2 transition ${
              isActive ? "bg-white font-medium text-stone-900 shadow-sm" : "text-stone-500"
            }`}
            key={item.value}
            onClick={() => {
              setPerspective(item.value);
            }}
            type="button"
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
