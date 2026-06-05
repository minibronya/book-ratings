import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/api/books": ["./data/book-ratings.sqlite"],
  },
};

export default nextConfig;
