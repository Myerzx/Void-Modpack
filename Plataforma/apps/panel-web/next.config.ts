import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Phase 2 is a fixture-only dashboard. Exporting static assets keeps the
  // Next.js build tool and its image pipeline out of the deployed runtime.
  output: 'export',
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
