/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Remote sessions' pty is a native module, loaded at runtime when it is installed.
  serverExternalPackages: ["node-pty"],
  // The gateway route streams SSE from Anthropic; keep the Node runtime.
  experimental: {
    proxyTimeout: 600_000,
  },
};

export default nextConfig;
