import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  serverExternalPackages: ["@napi-rs/keyring", "pdf-lib", "jszip"],
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  experimental: {
    serverActions: { bodySizeLimit: "48mb" },
  },
};

export default nextConfig;
