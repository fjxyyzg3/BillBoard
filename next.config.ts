import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  allowedDevOrigins: ["127.0.0.1", "115.29.200.7"],
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
