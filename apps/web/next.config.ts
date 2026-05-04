import type { NextConfig } from "next";

// Load repo-root `.env` before Next reads config (Node-only; no `@next/env` / webpack).
import "./src/lib/root-env";

const nextConfig: NextConfig = {
  transpilePackages: ["@ganga/shared", "@ganga/db"],
};

export default nextConfig;
