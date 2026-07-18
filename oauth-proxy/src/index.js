/**
 * Minimal GitHub OAuth proxy for Decap CMS, running on Cloudflare Workers.
 *
 * Implements the standard Decap/Netlify CMS OAuth handshake:
 *   1. GET /auth              -> redirects the popup window to GitHub's authorize page
 *   2. GET /callback?code=... -> exchanges the code for an access_token, then
 *                                 postMessages it back to the Decap CMS window
 *                                 that opened this popup.
 *
 * Security measures:
 *   - CSRF protection: a random `state` value is generated in /auth and stored
 *     in a short-lived, HttpOnly cookie. /callback rejects the request unless
 *     the returned `state` matches the cookie.
 *   - Origin allowlist: the resulting token is only ever postMessage()-d back
 *     to an origin listed in ALLOWED_ORIGINS - never to an arbitrary caller.
 *
 * Required Worker secrets (set with `npx wrangler secret put NAME`):
 *   GITHUB_OAUTH_ID      - the GitHub OAuth App's Client ID
 *   GITHUB_OAUTH_SECRET  - the GitHub OAuth App's Client Secret
 *   ALLOWED_ORIGINS      - comma-separated list of origins allowed to receive
 *                          the token, e.g. "https://mindendo.hu,https://mindendo-site.pages.dev"
 */

function parseCookie(header, name) {
  if (!header) return null;
  const match = header.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return match ? match[1] : null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/auth") {
      const state = crypto.randomUUID();
      const params = new URLSearchParams({
        client_id: env.GITHUB_OAUTH_ID,
        redirect_uri: url.origin + "/callback",
        scope: "repo,user",
        state: state,
      });

      const response = Response.redirect(
        "https://github.com/login/oauth/authorize?" + params.toString(),
        302
      );
      // Rebuild the response so we can attach a Set-Cookie header
      // (Response.redirect() returns an immutable response).
      const redirect = new Response(null, {
        status: 302,
        headers: response.headers,
      });
      redirect.headers.set(
        "Set-Cookie",
        "oauth_state=" +
          state +
          "; HttpOnly; Secure; SameSite=Lax; Max-Age=600; Path=/"
      );
      return redirect;
    }

    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      const cookieState = parseCookie(
        request.headers.get("Cookie"),
        "oauth_state"
      );

      if (!code) {
        return new Response("Hiányzó 'code' paraméter.", { status: 400 });
      }
      if (!returnedState || !cookieState || returnedState !== cookieState) {
        return new Response(
          "Érvénytelen vagy hiányzó state - a bejelentkezési kísérlet gyanús, megszakítva.",
          { status: 400 }
        );
      }

      const tokenRes = await fetch(
        "https://github.com/login/oauth/access_token",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            client_id: env.GITHUB_OAUTH_ID,
            client_secret: env.GITHUB_OAUTH_SECRET,
            code: code,
          }),
        }
      );

      const tokenData = await tokenRes.json();

      if (tokenData.error || !tokenData.access_token) {
        return new Response(
          "OAuth hiba: " + (tokenData.error_description || "ismeretlen hiba"),
          { status: 400 }
        );
      }

      const payload = JSON.stringify({
        token: tokenData.access_token,
        provider: "github",
      });

      const allowedOrigins = (env.ALLOWED_ORIGINS || "")
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean);

      const html =
        "<!doctype html><html><body><script>" +
        "(function(){" +
        "var allowed = " +
        JSON.stringify(allowedOrigins) +
        ";" +
        "function receiveMessage(e){" +
        "if (allowed.indexOf(e.origin) === -1) { return; }" +
        "window.opener.postMessage(" +
        "'authorization:github:success:" +
        payload.replace(/'/g, "\\'") +
        "'," +
        "e.origin" +
        ");" +
        "}" +
        "window.addEventListener('message', receiveMessage, false);" +
        "window.opener.postMessage('authorizing:github', '*');" +
        "})();" +
        "</script></body></html>";

      return new Response(html, {
        headers: {
          "Content-Type": "text/html;charset=UTF-8",
          "Set-Cookie":
            "oauth_state=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/",
        },
      });
    }

    return new Response("Mindendo Decap OAuth proxy fut.", { status: 200 });
  },
};
