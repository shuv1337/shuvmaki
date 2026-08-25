import { afterEach, describe, expect, test } from "vitest";
import {
  DEFAULT_KIMAKI_TUNNEL_URL_TEMPLATE,
  getKimakiTunnelUrlTemplate,
} from "./tunnel-config.js";

afterEach(() => {
  delete process.env.KIMAKI_TUNNEL_BASE_DOMAIN;
  delete process.env.KIMAKI_TUNNEL_URL_TEMPLATE;
});

describe("getKimakiTunnelUrlTemplate", () => {
  test("uses the hosted shuvmaki tunnel domain by default", () => {
    expect(getKimakiTunnelUrlTemplate()).toBe(
      DEFAULT_KIMAKI_TUNNEL_URL_TEMPLATE,
    );
  });

  test("supports the documented base-domain override", () => {
    process.env.KIMAKI_TUNNEL_BASE_DOMAIN = "tunnel.example.com";
    expect(getKimakiTunnelUrlTemplate()).toBe(
      "https://{id}.tunnel.example.com",
    );
  });

  test("prefers an explicit URL template", () => {
    process.env.KIMAKI_TUNNEL_BASE_DOMAIN = "ignored.example.com";
    process.env.KIMAKI_TUNNEL_URL_TEMPLATE = "https://preview-{id}.example.com";
    expect(getKimakiTunnelUrlTemplate()).toBe(
      "https://preview-{id}.example.com",
    );
  });
});
