import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock env module before importing zebra
vi.mock("../../env", () => ({
  env: {
    LANGFUSE_ZEBRA_APP_NAME: "",
    LANGFUSE_ZEBRA_REF_KEY: "",
    LANGFUSE_ZEBRA_PROXY_HOST: "",
    DEPLOY_ENV: "DEVELOPMENT",
  },
}));

// Mock logger
vi.mock("../logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  REF_KEY_MAP,
  ZEBRA_DEFAULTS,
  resolveRefKey,
  resolveZebraUri,
  getZebraPoolOptions,
} from "./zebra";
import { env } from "../../env";

describe("Zebra Proxy integration", () => {
  beforeEach(() => {
    // Reset env vars
    env.LANGFUSE_ZEBRA_APP_NAME = "";
    env.LANGFUSE_ZEBRA_REF_KEY = "";
    env.LANGFUSE_ZEBRA_PROXY_HOST = "";
    env.DEPLOY_ENV = "DEVELOPMENT";
  });

  describe("REF_KEY_MAP", () => {
    it("should have all 4 environments", () => {
      expect(Object.keys(REF_KEY_MAP)).toHaveLength(4);
      expect(REF_KEY_MAP.PRODUCTION).toBe("bjintel_langfuse_product");
      expect(REF_KEY_MAP.STAGING).toBe("bjintel_langfuse_staging");
      expect(REF_KEY_MAP.TEST).toBe("bjintel_langfuse_test");
      expect(REF_KEY_MAP.DEVELOPMENT).toBe("bjintel_langfuse_dev");
    });

    it("should follow aip's ref_key naming convention", () => {
      // aip uses: bjintel_aip_product / bjintel_aip_test
      // Langfuse uses: bjintel_langfuse_product / bjintel_langfuse_test
      for (const key of Object.values(REF_KEY_MAP)) {
        expect(key).toMatch(/^bjintel_langfuse_/);
      }
    });
  });

  describe("ZEBRA_DEFAULTS", () => {
    it("should match aip's connection parameters", () => {
      // aip's zebra_utils.py: connect_timeout=2, read_timeout=20, pool_recycle=3600
      expect(ZEBRA_DEFAULTS.connectTimeout).toBe(2_000); // 2s in ms
      expect(ZEBRA_DEFAULTS.readTimeout).toBe(20_000); // 20s in ms
      expect(ZEBRA_DEFAULTS.poolRecycle).toBe(3_600); // 1 hour in s
    });

    it("should use utf8mb4 charset", () => {
      // aip uses utf8, but we need utf8mb4 for full Unicode support
      expect(ZEBRA_DEFAULTS.charset).toBe("utf8mb4");
    });
  });

  describe("resolveRefKey", () => {
    it("should use explicit LANGFUSE_ZEBRA_REF_KEY when set", () => {
      env.LANGFUSE_ZEBRA_REF_KEY = "custom_ref_key";
      expect(resolveRefKey()).toBe("custom_ref_key");
    });

    it("should map DEPLOY_ENV=PRODUCTION to production ref_key", () => {
      env.DEPLOY_ENV = "PRODUCTION";
      expect(resolveRefKey()).toBe("bjintel_langfuse_product");
    });

    it("should map DEPLOY_ENV=TEST to test ref_key", () => {
      env.DEPLOY_ENV = "TEST";
      expect(resolveRefKey()).toBe("bjintel_langfuse_test");
    });

    it("should map DEPLOY_ENV=STAGING to staging ref_key", () => {
      env.DEPLOY_ENV = "STAGING";
      expect(resolveRefKey()).toBe("bjintel_langfuse_staging");
    });

    it("should default to DEVELOPMENT when DEPLOY_ENV is DEVELOPMENT", () => {
      env.DEPLOY_ENV = "DEVELOPMENT";
      expect(resolveRefKey()).toBe("bjintel_langfuse_dev");
    });

    it("should prioritize LANGFUSE_ZEBRA_REF_KEY over DEPLOY_ENV", () => {
      env.LANGFUSE_ZEBRA_REF_KEY = "explicit_key";
      env.DEPLOY_ENV = "PRODUCTION";
      expect(resolveRefKey()).toBe("explicit_key");
    });
  });

  describe("resolveZebraUri", () => {
    it("should build correct URI from ref_key and defaults", () => {
      env.LANGFUSE_ZEBRA_REF_KEY = "bjintel_langfuse_test";
      const uri = resolveZebraUri();
      expect(uri).toBe(
        `mysql://com.sankuai.t0.langfuse@zebra-proxy.internal:3306/bjintel_langfuse_test`,
      );
    });

    it("should use custom app name when set", () => {
      env.LANGFUSE_ZEBRA_REF_KEY = "test_key";
      env.LANGFUSE_ZEBRA_APP_NAME = "my_app";
      const uri = resolveZebraUri();
      expect(uri).toContain("mysql://my_app@");
    });

    it("should use custom proxy host when set", () => {
      env.LANGFUSE_ZEBRA_REF_KEY = "test_key";
      env.LANGFUSE_ZEBRA_PROXY_HOST = "my-proxy.host";
      const uri = resolveZebraUri();
      expect(uri).toContain("@my-proxy.host:3306/");
    });

    it("should resolve from DEPLOY_ENV when no explicit ref_key", () => {
      env.DEPLOY_ENV = "PRODUCTION";
      const uri = resolveZebraUri();
      expect(uri).not.toBeNull();
      expect(uri).toContain("bjintel_langfuse_product");
    });
  });

  describe("getZebraPoolOptions", () => {
    it("should return aip-compatible pool options", () => {
      const opts = getZebraPoolOptions();
      expect(opts.connectTimeout).toBe(2_000);
      expect(opts.readTimeout).toBe(20_000);
      expect(opts.poolRecycle).toBe(3_600);
      expect(opts.charset).toBe("utf8mb4");
    });
  });
});
