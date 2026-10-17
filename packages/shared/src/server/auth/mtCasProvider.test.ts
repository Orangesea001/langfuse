import crypto from "crypto";
import { describe, expect, it, vi } from "vitest";

import { MtCasProvider } from "./mtCasProvider";

const baseOptions = {
  clientId: "client-id",
  clientSecret: "client-secret",
  loginServer: "https://ssosv.sankuai.com/sson",
  validateServer: "https://sso.vip.sankuai.com/sson",
};

describe("MtCasProvider", () => {
  it("registers under the mt-sso id with the provider callback path", () => {
    const provider = MtCasProvider(baseOptions);

    expect(provider.id).toBe("mt-sso");
    expect(provider.type).toBe("oauth");
    expect(provider.name).toBe("Meituan SSO");
  });

  it("points the authorization url at the SSO login endpoint", () => {
    const provider = MtCasProvider(baseOptions);
    const authorization = provider.authorization as { url: string } | string;

    expect(
      typeof authorization === "string" ? authorization : authorization.url,
    ).toBe("https://ssosv.sankuai.com/sson/login");
  });

  it("maps the MIS login to the identity anchor and keeps email null", () => {
    const provider = MtCasProvider(baseOptions);

    const result = provider.profile(
      { login: "linshu07", loginName: "linshu07", name: "林述" },
      {} as any,
    ) as any;

    expect(result.id).toBe("linshu07");
    expect(result.name).toBe("林述");
    expect(result.email).toBeNull();
  });

  it("falls back to loginName and then to the login for the identity", () => {
    const provider = MtCasProvider(baseOptions);

    expect(
      provider.profile({ loginName: "zhangsan" }, {} as any),
    ).toMatchObject({ id: "zhangsan", email: null });
    expect(provider.profile({ login: "lisi" }, {} as any)).toMatchObject({
      id: "lisi",
      email: null,
    });
  });

  it("exchanges the code with an MWS BA signed request", async () => {
    const provider = MtCasProvider(baseOptions);
    const handler = provider.token as { request: Function };
    if (!handler?.request) throw new Error("token.request missing");

    const fetchMock = vi.fn(async () =>
      Response.json({ code: 200, data: { accessToken: "ssoid-1" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tokens = await handler.request({
      provider,
      params: { code: "auth-code" },
      checks: {},
      client: {},
    });

    expect(tokens).toMatchObject({
      tokens: { access_token: "ssoid-1" },
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    expect(String(url)).toContain(
      "https://ssosv.sankuai.com/sson/oauth2.0/access-token?code=auth-code",
    );
    expect(String(url)).toContain("&t=");
    // MWS BA authorization header: MWS <clientId>:<base64 hmac-sha1>
    const auth = init.headers.Authorization;
    expect(auth).toMatch(/^MWS client-id:/);
    const expectedSignature = crypto
      .createHmac("sha1", "client-secret")
      .update(`GET /sson/oauth2.0/access-token\n${init.headers.Date}`, "utf8")
      .digest("base64");
    expect(auth).toBe(`MWS client-id:${expectedSignature}`);

    vi.unstubAllGlobals();
  });

  it("fetches the profile from the validate server with the ssoid", async () => {
    const provider = MtCasProvider(baseOptions);
    const handler = provider.userinfo as { request: Function };
    if (!handler?.request) throw new Error("userinfo.request missing");

    const fetchMock = vi.fn(async () =>
      Response.json({
        code: 200,
        data: { login: "linshu07", name: "林述" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const profile = await handler.request({
      provider,
      tokens: { access_token: "ssoid-1" },
      client: {},
    });

    expect(profile).toMatchObject({ login: "linshu07", name: "林述" });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    expect(String(url)).toBe(
      "https://sso.vip.sankuai.com/sson/open/api/session/userinfo",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ accessToken: "ssoid-1" });
    expect(init.headers.Authorization).toMatch(/^MWS client-id:/);

    vi.unstubAllGlobals();
  });

  it("throws on failed token exchange", async () => {
    const provider = MtCasProvider(baseOptions);
    const handler = provider.token as { request: Function };

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ code: 500 })),
    );

    await expect(
      handler.request({
        provider,
        params: { code: "auth-code" },
        checks: {},
        client: {},
      }),
    ).rejects.toThrow("MTCAS access-token exchange failed");

    vi.unstubAllGlobals();
  });

  it("throws on failed userinfo validation", async () => {
    const provider = MtCasProvider(baseOptions);
    const handler = provider.userinfo as { request: Function };

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ code: 401 })),
    );

    await expect(
      handler.request({
        provider,
        tokens: { access_token: "expired" },
        client: {},
      }),
    ).rejects.toThrow("MTCAS userinfo validation failed");

    vi.unstubAllGlobals();
  });
});
