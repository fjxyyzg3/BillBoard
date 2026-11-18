/* eslint-disable @next/next/no-img-element */
import { ListTodo, Search } from "lucide-react";
import addTitleArt from "@/assets/art/add-title.webp";
import homeTitleArt from "@/assets/art/home-title.webp";

type PageHeroArtProps = {
  variant: "add" | "home" | "records";
};

const titleArt = {
  add: {
    alt: "",
    className: "h-12 w-20 sm:h-16 sm:w-28",
    height: 989,
    src: addTitleArt,
    width: 1591,
  },
  home: {
    alt: "",
    className: "h-12 w-24 sm:h-16 sm:w-32",
    height: 878,
    src: homeTitleArt,
    width: 1792,
  },
} as const;

function getStaticAssetSrc(asset: string | { src: string }) {
  return typeof asset === "string" ? asset : asset.src;
}

function TitleImageArt({ variant }: { variant: "add" | "home" }) {
  const art = titleArt[variant];

  return (
    <img
      alt={art.alt}
      aria-hidden="true"
      className={`${art.className} pointer-events-none shrink-0 object-contain`}
      decoding="async"
      height={art.height}
      loading="lazy"
      src={getStaticAssetSrc(art.src)}
      width={art.width}
    />
  );
}

export function PageHeroArt({ variant }: PageHeroArtProps) {
  if (variant === "add" || variant === "home") {
    return <TitleImageArt variant={variant} />;
  }

  return (
    <div
      aria-hidden="true"
      className="relative h-12 w-20 shrink-0 overflow-hidden rounded-2xl bg-[#fff3df]"
    >
      <Search className="absolute left-3 top-2 h-7 w-7 text-[#5b3219]" strokeWidth={1.8} />
      <ListTodo className="absolute bottom-2 right-3 h-6 w-6 text-[var(--bb-accent)]" />
    </div>
  );
}
