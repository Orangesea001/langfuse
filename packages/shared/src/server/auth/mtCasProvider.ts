import crypto from "crypto";
import type { OAuthConfig, OAuthUserConfig } from "next-auth/providers/oauth";

/**
 * Meituan SSO MTCAS provider (the legacy protocol used by e.g. aip), adapted
 * to NextAuth v4.
 *
 * Flow (mirrors aip's api/extensions/sso/sso.py):
 * 1. Sign-in: browser is redirected to
 *      <loginServer>/sson/login?redirect_uri=<callbackUrl>&client_id=<id>
 * 2. Callback: SSO redirects back with ?code=...
 * 3. Token exchange: GET <loginServer>/sson/oauth2.0/access-token?code=..&t=..
 *    with MWS BA authentication (HMAC-SHA1 signature + Date header), returns
 *    { data: { accessToken } } — the "ssoid".
 * 4. Profile: POST <validateServer>/open/api/session/userinfo with
 *    { accessToken } (also MWS BA authenticated), returns
 *    { data: { login (MIS), loginName, name, ... } }.
 *
 * Identity is the MIS login (`login`/`loginName`); no email is involved at
 * any point (User.email stays NULL — see the emailless login patches).
 */

interface MtCasUser extends Record<string, any> {
  login?: string;
  loginName?: string;
  name?: string;
}

export interface MtCasProviderOptions extends Omit<
  OAuthUserConfig<MtCasUser>,
  | "clientId"
  | "clientSecret"
  | "issuer"
  | "wellKnown"
  | "token"
  | "userinfo"
  | "checks"
  | "idToken"
  | "authorization"
> {
  clientId: string;
  clientSecret: string;
  /** Login/authorize server, e.g. https://ssosv.sankuai.com/sson (prod). */
  loginServer: string;
  /**
   * Token/userinfo server, e.g. https://sso.vip.sankuai.com (prod).
   * NOTE: unlike the login server, this base carries NO /sson prefix — aip
   * builds the userinfo URL via urljoin(base, '/open/api/session/userinfo')
   * which drops any path in the base. Signing path is always
   * /open/api/session/userinfo.
   */
  validateServer: string;
}

/** Builds the MWS BA Authorization header value (HMAC-SHA1, as in aip). */
function mwsAuthorization(
  method: string,
  uri: string,
  gmtTime: string,
  clientId: string,
  clientSecret: string,
): string {
  const stringToSign = `${method} ${uri}\n${gmtTime}`;
  const signature = crypto
    .createHmac("sha1", clientSecret)
    .update(stringToSign, "utf8")
    .digest("base64");
  return `MWS ${clientId}:${signature}`;
}

/** Headers required for MWS BA authenticated calls to the SSO servers. */
function mwsHeaders(
  method: string,
  uri: string,
  clientId: string,
  clientSecret: string,
): Record<string, string> {
  const gmtTime = new Date(
    Date.UTC(
      new Date().getUTCFullYear(),
      new Date().getUTCMonth(),
      new Date().getUTCDate(),
      new Date().getUTCHours(),
      new Date().getUTCMinutes(),
      new Date().getUTCSeconds(),
    ),
  )
    .toUTCString()
    .replace("GMT", "GMT"); // e.g. "Mon, 21 Sep 2026 08:00:00 GMT"
  return {
    Date: gmtTime,
    Authorization: mwsAuthorization(
      method,
      uri,
      gmtTime,
      clientId,
      clientSecret,
    ),
    "Content-Type": "application/json;charset=UTF-8",
  };
}

interface MtCasTokenResponse {
  code?: number;
  data?: {
    accessToken?: string;
    expires?: number;
  };
}

interface MtCasUserResponse {
  code?: number;
  data?: MtCasUser;
}

export function MtCasProvider(
  options: MtCasProviderOptions,
): OAuthConfig<MtCasUser> {
  const loginBase = options.loginServer.replace(/\/$/, "");
  const validateBase = options.validateServer.replace(/\/$/, "");
  const tokenUrl = `${loginBase}/oauth2.0/access-token`;

  return {
    id: "mt-sso",
    name: options.name ?? "Meituan SSO",
    type: "oauth",
    // No .well-known discovery: endpoints are provided explicitly below.
    issuer: loginBase,
    authorization: {
      url: `${loginBase}/login`,
      // aip's sign-in URL carries redirect_uri + client_id only. The normal
      // entry point for this deployment is the middleware's direct 302 to
      // that URL (aip-style); this config only matters for the fallback
      // POST /api/auth/signin/mt-sso route, which NextAuth/openid-client
      // would drive through here (adding scope/response_type defaults that
      // MTCAS ignores).
      params: {},
    },
    token: {
      url: tokenUrl,
      async request({ provider, params }) {
        const code = typeof params.code === "string" ? params.code : undefined;
        if (!code) throw new Error("MTCAS callback is missing ?code=");

        const path = "/sson/oauth2.0/access-token";
        const url = `${tokenUrl}?code=${encodeURIComponent(code)}&t=${Date.now()}`;
        const clientId = (provider.clientId ?? options.clientId) as string;
        const clientSecret = (provider.clientSecret ??
          options.clientSecret) as string;
        const headers = mwsHeaders("GET", path, clientId, clientSecret);

        const res = await fetch(url, { headers });
        if (!res.ok)
          throw new Error(`MTCAS access-token endpoint failed: ${res.status}`);
        const body = (await res.json()) as MtCasTokenResponse;
        const accessToken = body?.data?.accessToken;
        if (body?.code !== 200 || !accessToken)
          throw new Error(
            `MTCAS access-token exchange failed: code=${body?.code}`,
          );

        // NextAuth expects an OAuth token-like object; the ssoid becomes the
        // access token that the userinfo request consumes.
        return {
          tokens: {
            access_token: accessToken,
            token_type: "Bearer",
          },
        };
      },
    },
    userinfo: {
      url: `${validateBase}/open/api/session/userinfo`,
      async request({ provider, tokens }) {
        const accessToken = tokens.access_token as string | undefined;
        if (!accessToken)
          throw new Error("MTCAS userinfo request is missing accessToken");

        const url = `${validateBase}/open/api/session/userinfo`;
        const clientId = (provider.clientId ?? options.clientId) as string;
        const clientSecret = (provider.clientSecret ??
          options.clientSecret) as string;
        const headers = mwsHeaders(
          "POST",
          "/open/api/session/userinfo",
          clientId,
          clientSecret,
        );

        const res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ accessToken }),
        });
        if (!res.ok)
          throw new Error(`MTCAS userinfo endpoint failed: ${res.status}`);
        const body = (await res.json()) as MtCasUserResponse;
        if (body?.code !== 200 || !body?.data)
          throw new Error(
            `MTCAS userinfo validation failed: code=${body?.code}`,
          );
        return body.data;
      },
    },
    // aip-style: the MTCAS protocol has no state/CSRF/PKCE. An empty checks
    // array keeps NextAuth from generating/validating a state cookie, so the
    // sign-in entry can be a plain server-side 302 built by middleware (see
    // web/src/middleware.ts) carrying only redirect_uri + client_id — exactly
    // like aip — and the SSO server's redirect back with ?code= is accepted
    // by NextAuth's callback route without any pre-established cookies.
    checks: [],
    profile(profile) {
      // `login`/`loginName` is the employee MIS login — the identity anchor
      // (stored as providerAccountId). Emailless: email stays null.
      const mis = profile.login || profile.loginName;
      if (!mis) {
        throw new Error(
          "MTCAS userinfo did not return a login/loginName (MIS): " +
            JSON.stringify(profile),
        );
      }
      return {
        id: mis,
        name: profile.name || mis,
        email: null,
        image: null,
      };
    },
    options: {
      clientId: options.clientId,
      clientSecret: options.clientSecret,
    },
  };
}
