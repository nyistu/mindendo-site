# Mindendo Decap OAuth proxy

Ez a kis Cloudflare Worker teszi lehetővé, hogy a Decap CMS admin felületén
GitHub-fiókkal (és a GitHub saját kétfaktoros azonosításával) lehessen
bejelentkezni, ahelyett hogy bárki jelszó nélkül szerkeszthetné a tartalmat.

## Telepítés lépései

1. **GitHub OAuth App létrehozása** — github.com/settings/developers →
   "New OAuth App". Kitöltendő mezők:
   - Application name: `Mindendo CMS`
   - Homepage URL: a végleges oldalad címe (pl. `https://mindendo.hu`)
   - Authorization callback URL: `https://mindendo-decap-oauth.<a-te-cloudflare-alnevedd>.workers.dev/callback`

   Mentés után kapsz egy **Client ID**-t, és generálhatsz egy **Client Secret**-et — mindkettő kell a következő lépéshez.

2. **Worker telepítése** (ebben a mappában):
   ```
   npx wrangler login
   npx wrangler deploy
   npx wrangler secret put GITHUB_OAUTH_ID
   npx wrangler secret put GITHUB_OAUTH_SECRET
   ```
   A `wrangler deploy` kiírja a Worker végleges URL-jét (pl. `https://mindendo-decap-oauth.valaki.workers.dev`).

3. **admin/config.yml frissítése** a saját GitHub felhasználóneveddel/repóddal
   és a most kapott Worker URL-lel (ez már elő van készítve, csak a
   `<ide-jon-a-github-felhasznalonev>` és a Worker URL helyét kell kitöltened).

4. Push-old fel a projektet GitHubra, majd kapcsold a repót Cloudflare
   Pages-hez vagy GitHub Pages-hez — onnantól az élő `/admin/` oldalon
   a "Login with GitHub" gombra kattintva a szerzők a saját GitHub-fiókjukkal
   jelentkezhetnek be.

Helyben, localhoston futtatva (`npm run start`) továbbra sem kell bejelentkezni —
ott megmarad az egyszerű helyi szerkesztés.
