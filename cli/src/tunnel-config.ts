import { resolveTunnelUrl } from "traforo/client";

export const DEFAULT_KIMAKI_TUNNEL_URL_TEMPLATE =
  "https://{id}-tunnel.shuv.bot";

export function getKimakiTunnelUrlTemplate(): string {
  const baseDomain = process.env.KIMAKI_TUNNEL_BASE_DOMAIN;
  const template =
    process.env.KIMAKI_TUNNEL_URL_TEMPLATE ||
    (baseDomain ? `https://{id}.${baseDomain}` : undefined) ||
    DEFAULT_KIMAKI_TUNNEL_URL_TEMPLATE;

  resolveTunnelUrl({ tunnelId: "config-check", urlTemplate: template });
  return template;
}
