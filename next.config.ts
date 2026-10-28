import type { NextConfig } from "next";

// Сборка для GitHub Pages: PAGES_BASE_PATH=/trading next build → статический сайт в out/.
const pagesBasePath = process.env.PAGES_BASE_PATH;

const nextConfig: NextConfig = {
  reactStrictMode: true,
  ...(pagesBasePath ? { output: "export", basePath: pagesBasePath, trailingSlash: true, images: { unoptimized: true } } : {}),
};

export default nextConfig;
