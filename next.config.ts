import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["http://127.0.0.1:51050", "http://localhost:51050", "http://127.0.0.1", "http://localhost"],
};

export default nextConfig;
