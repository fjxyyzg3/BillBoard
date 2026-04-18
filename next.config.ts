import type { NextConfig } from "next";
import { join } from "node:path";

const nextConfig: NextConfig = {
  output: "standalone",
  allowedDevOrigins: ["127.0.0.1"],
  turbopack: {
    root: join(process.cwd(), "..", ".."),
  },
};

export default nextConfig;
