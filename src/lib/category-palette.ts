export type CategoryVisualColor = {
  background: string;
  chart: string;
  foreground: string;
};

const clay: CategoryVisualColor = {
  background: "#FBE7DF",
  chart: "#D48673",
  foreground: "#B86A5B",
};

const sage: CategoryVisualColor = {
  background: "#E6F0E8",
  chart: "#78A785",
  foreground: "#5E8F70",
};

const apricot: CategoryVisualColor = {
  background: "#FBEAD8",
  chart: "#D99A5F",
  foreground: "#B97543",
};

const honey: CategoryVisualColor = {
  background: "#F6EBD4",
  chart: "#C9A15F",
  foreground: "#9B7744",
};

const rose: CategoryVisualColor = {
  background: "#F8E2E1",
  chart: "#CF8881",
  foreground: "#B46B67",
};

const mauve: CategoryVisualColor = {
  background: "#EFE6EF",
  chart: "#A98AAE",
  foreground: "#846B8D",
};

const mist: CategoryVisualColor = {
  background: "#E5EEF3",
  chart: "#82A0AF",
  foreground: "#627F92",
};

const blueGray: CategoryVisualColor = {
  background: "#E8EDF5",
  chart: "#8B9FBC",
  foreground: "#687FA0",
};

const wheat: CategoryVisualColor = {
  background: "#F2E9CF",
  chart: "#BCA260",
  foreground: "#927742",
};

const blush: CategoryVisualColor = {
  background: "#FBE5E9",
  chart: "#D399A8",
  foreground: "#B67684",
};

const teal: CategoryVisualColor = {
  background: "#E2F0EF",
  chart: "#7EA9A6",
  foreground: "#5C8D8A",
};

const taupe: CategoryVisualColor = {
  background: "#EEEAE5",
  chart: "#A39A91",
  foreground: "#756B61",
};

export const categoryColorPalette: CategoryVisualColor[] = [
  clay,
  sage,
  apricot,
  honey,
  rose,
  mauve,
  mist,
  blueGray,
  wheat,
  blush,
  teal,
  taupe,
];

const defaultCategoryVisualColor = taupe;

const categoryVisualColors: Record<string, CategoryVisualColor> = {
  Bonus: apricot,
  Childcare: blush,
  Dining: clay,
  Entertainment: mauve,
  Home: honey,
  Investment: wheat,
  Medical: rose,
  Other: taupe,
  "Parent Care": wheat,
  Refund: teal,
  Reimbursement: mist,
  Salary: sage,
  Shopping: apricot,
  Social: mist,
  Study: blueGray,
  Transport: sage,
  Travel: teal,
};

function getFallbackCategoryColor(fallbackIndex: number | undefined) {
  if (fallbackIndex === undefined) {
    return defaultCategoryVisualColor;
  }

  const paletteIndex = ((fallbackIndex % categoryColorPalette.length) + categoryColorPalette.length) %
    categoryColorPalette.length;

  return categoryColorPalette[paletteIndex] ?? defaultCategoryVisualColor;
}

export function getCategoryVisualColor(categoryName: string, fallbackIndex?: number) {
  return categoryVisualColors[categoryName] ?? getFallbackCategoryColor(fallbackIndex);
}

export function getCategoryChartColor(categoryName: string, fallbackIndex?: number) {
  return getCategoryVisualColor(categoryName, fallbackIndex).chart;
}
