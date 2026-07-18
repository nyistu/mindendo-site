/**
 * Minimal GitHub OAuth proxy for Decap CMS, running on Cloudflare Workers.
 *
 * Implements the standard Decap/Netlify CMS OAuth handshake:
 *   1. GET /auth              -> redirects the popup window to GitHub's authorize page
 *   2. GET /callback?code=... -> exchanges the code for an access_token, then
 *                                 postMessages it back to the Decap CMS window
 *                                 that opened this popup.
 *
 * Required Worker secrets (set with `npx wrangler secret put NAME`):
 *   GITHUB_OAUTH_ID      - the GitHub OAuth App's Client ID
 *   GITHUB_OAUTH_SECRET  - the GitHub OAuth App's Client Secret
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/auth") {
      const params = new URLSearchParams({
        client_id: env.GITHUB_OAUTH_ID,
        redirect_uri: url.origin + "/callback",
        scope: "repo,user",
        state: crypto.randomUUID(),
      });
      return Response.redirect(
        "https://github.com/login/oauth/authorize?" + params.toString(),
        302
      );
    }

    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code");
      if (!code) {
        return new Response("Hiányzó 'code' paraméter.", { status: 400 });
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

      const html =
        "<!doctype html><html><body><script>" +
        "(function(){" +
        "function receiveMessage(e){" +
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
        headers: { "Content-Type": "text/html;charset=UTF-8" },
      });
    }

    return new Response("Mindendo Decap OAuth proxy fut.", { status: 200 });
  },
};
