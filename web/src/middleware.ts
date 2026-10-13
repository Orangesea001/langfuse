import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";

/**
 * Global auth interceptor: visitors without a session are sent straight to
 * the Meituan SSO login page ("Meituan SSO" is the single sign-in method on
 * this deployment), skipping the sign-in page entirely.
 *
 * Meituan SSO (MTCAS) deployments use the aip-style direct sign-in:
 * - Unauthenticated visitors are 302'd by the server directly to
 *   <AUTH_MT_CAS_LOGIN_SERVER>/login?redirect_uri=<callback>&client_id=<id>
 *   — no state parameter, no CSRF token, no intermediate sign-in page, the
 *   exact same URL aip's before_request interceptor builds.
 * - The SSO server redirects back with ?code= to the redirect_uri, which is
 *   NextAuth's callback route (/api/auth/callback/mt-sso). It exchanges the
 *   code server-side (MWS BA signed) and issues the session cookie.
 * - The originally requested URL rides along inside redirect_uri as a
 *   callbackUrl query param, which NextAuth's callback route reads to send
 *   the user back where they started.
 *
 * Session detection uses the standard NextAuth JWT (next-auth/jwt). The
 * token is present for authenticated users only, so its absence is the
 * "not signed in" signal — identical to the page-level sentinel guards
 * (`if (!session?.user) redirect("/auth/sign-in")`), minus the extra hop.
 *
 * Paths that must stay reachable without a session are allowed through:
 * the NextAuth routes (including the SSO callback
 * `/api/auth/callback/mt-sso`), the sign-in/error pages, SDK-facing public
 * APIs (authenticated via project API keys, not cookies), probes, and
 * Next.js internals.
 *
 * basePath (NEXT_PUBLIC_BASE_PATH, e.g. "/langfuse") is already stripped
 * from req.nextUrl.pathname by Next.js, so matching works with and
 * without a base path; the SSO redirect URLs are rebuilt on top of the
 * original request URL so the base path is preserved.
 */

// Allow-list for requests that must not require a session.
const PUBLIC_PATH_PREFIXES = [
  // NextAuth sign-in/callback/sign-out routes — must be reachable for the
  // SSO flow itself to complete.
  "/api/auth",
  // Login/error pages (the SSO button lives here; also the target NextAuth
  // redirects to on auth errors).
  "/auth",
  // SDK ingestion & public APIs — authenticated by project API keys.
  "/api/public",
  // Internal APIs authenticated by service headers, not user sessions.
  "/api/internal",
  // Health/readiness probes.
  "/api/health",
  "/monitor/alive",
  // Docs route (public swagger).
  "/api/docs",
  // well-known endpoints (e.g. for SSO discovery).
  "/api/well-known",
];

const isPublicPath = (pathname: string) =>
  PUBLIC_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );

export async function middleware(req: NextRequest) {
  if (isPublicPath(req.nextUrl.pathname)) return NextResponse.next();

  const token = await getToken({
    req,
    secret: process.env.NEXTAUTH_SECRET,
    // Read the session cookie regardless of the NEXTAUTH_URL protocol.
    secureCookie: req.nextUrl.protocol === "https:",
  });

  if (token) return NextResponse.next();

  // Meituan SSO (MTCAS) is configured: aip-style direct 302 to the company
  // SSO login page. Built exactly like aip's before_request interceptor:
  // only redirect_uri + client_id, nothing else.
  const clientId = process.env.AUTH_MT_CAS_CLIENT_ID;
  const loginServer = process.env.AUTH_MT_CAS_LOGIN_SERVER?.replace(/\/+$/, "");
  if (clientId && loginServer) {
    // Canonical origin: NEXTAUTH_URL when configured (robust behind reverse
    // proxies — e.g. local nginx for the dev.evp.* domain or the production
    // gateway — where req.url may carry the internal upstream origin),
    // otherwise the request's own origin.
    const origin = (
      process.env.NEXTAUTH_URL ?? req.nextUrl.origin
    ).replace(/\/+$/, "");
    const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
    // The SSO server appends ?code= to redirect_uri after login; NextAuth's
    // callback route reads callbackUrl from the query to return the user to
    // the page they originally requested.
    const originalUrl = `${origin}${basePath}${req.nextUrl.pathname}${req.nextUrl.search}`;
    const redirectUri = new URL(
      `${basePath}/api/auth/callback/mt-sso`,
      origin,
    );
    redirectUri.searchParams.set("callbackUrl", originalUrl);

    const ssoLoginUrl = new URL(`${loginServer}/login`);
    ssoLoginUrl.searchParams.set("redirect_uri", redirectUri.toString());
    ssoLoginUrl.searchParams.set("client_id", clientId);

    return NextResponse.redirect(ssoLoginUrl);
  }

  // Fallback for non-MTCAS deployments: send unauthenticated visitors to
  // the regular sign-in page.
  const signInUrl = new URL("/auth/sign-in", req.url);
  signInUrl.searchParams.set("callbackUrl", req.nextUrl.pathname);

  return NextResponse.redirect(signInUrl);
}

export const config = {
  matcher: [
    /*
     * Run on all paths except Next.js internals, static files, and
     * NextAuth's own routes (covered by the allow-list above anyway, but
     * excluding them here avoids the token check entirely for e.g. static
     * assets).
     *
     * "/" is listed explicitly: the negative-lookahead regex does not match
     * the bare root path, which would let unauthenticated visitors reach the
     * root page (and its client-side sign-in redirect) instead of the SSO
     * flow.
     */
    "/",
    "/((?!_next/static|_next/image|favicon.ico|api/auth).*)",
  ],
};
