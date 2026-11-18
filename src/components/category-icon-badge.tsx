import {
  Baby,
  Banknote,
  BookOpen,
  Briefcase,
  Car,
  CircleEllipsis,
  Gamepad2,
  Gift,
  HandCoins,
  HeartPulse,
  House,
  Plane,
  ShoppingBag,
  Users,
  Utensils,
  type LucideIcon,
} from "lucide-react";
import type { CSSProperties } from "react";
import { getCategoryVisualColor, type CategoryVisualColor } from "@/lib/category-palette";

type CategoryVisual = {
  Icon: LucideIcon;
};

const defaultVisual: CategoryVisual = {
  Icon: CircleEllipsis,
};

const categoryVisuals: Record<string, CategoryVisual> = {
  Bonus: { Icon: Gift },
  Childcare: { Icon: Baby },
  Dining: { Icon: Utensils },
  Entertainment: { Icon: Gamepad2 },
  Home: { Icon: House },
  Investment: { Icon: Banknote },
  Medical: { Icon: HeartPulse },
  Other: { Icon: CircleEllipsis },
  "Parent Care": { Icon: HandCoins },
  Refund: { Icon: HandCoins },
  Reimbursement: { Icon: Briefcase },
  Salary: { Icon: Banknote },
  Shopping: { Icon: ShoppingBag },
  Social: { Icon: Users },
  Study: { Icon: BookOpen },
  Transport: { Icon: Car },
  Travel: { Icon: Plane },
};

type CategoryIconBadgeProps = {
  categoryName: string;
  className?: string;
  iconClassName?: string;
};

function categoryIconStyle(color: CategoryVisualColor): CSSProperties {
  return {
    backgroundColor: color.background,
    color: color.foreground,
  };
}

export function CategoryIconBadge({
  categoryName,
  className,
  iconClassName,
}: CategoryIconBadgeProps) {
  const visual = categoryVisuals[categoryName] ?? defaultVisual;
  const Icon = visual.Icon;

  return (
    <span
      aria-hidden="true"
      className={[
        "inline-flex shrink-0 items-center justify-center rounded-full",
        className ?? "h-9 w-9",
      ].join(" ")}
      style={categoryIconStyle(getCategoryVisualColor(categoryName))}
    >
      <Icon className={iconClassName ?? "h-5 w-5"} strokeWidth={1.6} />
    </span>
  );
}
