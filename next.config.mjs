const smithersGatewayUrl = process.env.SMITHERS_GATEWAY_URL ?? "http://127.0.0.1:7331";

/** @type {import("next").NextConfig} */
const nextConfig = {
  transpilePackages: [
    "smithers-orchestrator",
    "@smithers-orchestrator/electric-proxy",
    "@smithers-orchestrator/gateway",
    "@smithers-orchestrator/gateway-client",
    "@smithers-orchestrator/gateway-react",
  ],
  async rewrites() {
    return [
      {
        source: "/v1/rpc/:path*",
        destination: `${smithersGatewayUrl}/v1/rpc/:path*`,
      },
      {
        source: "/v1/api/:path*",
        destination: `${smithersGatewayUrl}/v1/api/:path*`,
      },
      {
        source: "/workflows/:path*",
        destination: `${smithersGatewayUrl}/workflows/:path*`,
      },
      {
        source: "/health",
        destination: `${smithersGatewayUrl}/health`,
      },
      {
        source: "/smithers-ws",
        destination: `${smithersGatewayUrl}/smithers-ws`,
      },
    ];
  },
};

export default nextConfig;
