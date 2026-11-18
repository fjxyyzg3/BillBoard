import type { MetadataRoute } from "next";
import packageJson from "../../package.json";
import { withAppBasePath } from "@/lib/base-path";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "家庭记账",
    short_name: "BillBoard",
    start_url: withAppBasePath("/home"),
    scope: withAppBasePath("/"),
    display: "standalone",
    background_color: "#fcfbfa",
    theme_color: "#c64d3b",
    icons: [
      {
        src: withAppBasePath(`/icons/icon-192.png?v=${packageJson.version}`),
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: withAppBasePath(`/icons/icon-512.png?v=${packageJson.version}`),
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: withAppBasePath(`/icons/icon-maskable-512.png?v=${packageJson.version}`),
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
