import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Hide the "N" dev tools button. Compile and runtime errors still appear.
  devIndicators: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
