/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The gateway route streams SSE from Anthropic; keep the Node runtime.
  experimental: {
    proxyTimeout: 600_000,
  },
};

export default nextConfig;
