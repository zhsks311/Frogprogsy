import { createMDX } from "fumadocs-mdx/next";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  basePath: "/Frogprogsy",
  assetPrefix: "/Frogprogsy",
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
  reactStrictMode: true,
  turbopack: {
    root,
  },
};

const withMDX = createMDX();

export default withMDX(nextConfig);
