# Mindendo auth proxy (felhasználónév + jelszó)

Ez a kis Cloudflare Worker teszi lehetővé, hogy a Decap CMS admin felületén
saját, itt regisztrált **felhasználónévvel és jelszóval** lehessen
bejelentkezni - a szerkesztőknek NEM kell GitHub-fiókot létrehozniuk.

Beépített védelem: 5 egymást követő sikertelen próbálkozás után a fiók
zárolásra kerül, és csak egy admin jogosultságú fiók tudja feloldani a
`/manage` felületen.

Fontos tudni: mivel a szerkesztők nem saját GitHub-fiókkal lépnek be, sikeres
belépés után mindenki ugyanazt a, a Workerben tárolt GitHub tokent kapja meg -
ez teszi lehetővé, hogy a Decap CMS ténylegesen írjon a repóba. Ha egy
szerkesztő hozzáférését vissza akarod vonni, elég a fiókját zárolni vagy
törölni a `/manage` felületen - nem kell a GitHub tokent lecserélni (kivéve,
ha maga a token szivárgott ki).

## Telepítés lépései

1. **GitHub Personal Access Token létrehozása** - github.com/settings/tokens →
   "Fine-grained tokens" → "Generate new token".
   - Repository access: csak a `mindendo-site` repó
   - Permissions: **Contents: Read and write**
   - Ne adj neki ennél több jogot.

   Ezt a tokent fogja minden bejelentkezett szerkesztő megkapni, szóval
   kizárólag erre a repóra legyen érvényes.

2. **KV namespace létrehozása** (ebben a mappában):
   ```
   npx wrangler login
   npx wrangler kv namespace create EDITORS_KV
   ```
   A parancs kiír egy `id`-t - írd be a `wrangler.toml`-ban az
   `ide-jon-a-kv-namespace-id` helyére.

3. **Worker telepítése és titkok beállítása**:
   ```
   npx wrangler deploy
   npx wrangler secret put GITHUB_PAT
   npx wrangler secret put SESSION_SECRET
   npx wrangler secret put ALLOWED_ORIGINS
   ```
   - `GITHUB_PAT`: az 1. lépésben létrehozott token.
   - `SESSION_SECRET`: bármilyen hosszú, véletlen string (ezzel írja alá a
     Worker az admin munkamenet-sütijét) - pl. generáld ezzel:
     `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   - `ALLOWED_ORIGINS`: vesszővel elválasztva azok a domainek, ahonnan az
     admin felület futni fog, pl.
     `https://mindendo.hu,https://mindendo-site.pages.dev`

   A `wrangler deploy` kiírja a Worker végleges URL-jét (pl.
   `https://mindendo-decap-auth.valaki.workers.dev`).

4. **admin/config.yml frissítése** a most kapott Worker URL-lel (a
   `base_url` mezőben) és a GitHub repód nevével.

5. **Első admin fiók feltöltése** - mivel kezdetben nincs egyetlen fiók sem a
   KV-ban, helyben kell legenerálni és feltölteni:
   ```
   node scripts/hash-password.js "ErősJelszó123" admin
   ```
   A szkript kiírja a pontos `wrangler kv key put` parancsot, amit már csak
   futtatnod kell (cseréld le benne a felhasználóneved). Ezután tudsz majd
   bejelentkezni a `https://<worker-url>/manage` oldalon, és onnantól a
   felületen keresztül tudsz további szerkesztőket felvenni vagy zárolt
   fiókokat feloldani.

6. Push-old fel a projektet GitHubra, majd kapcsold a repót Cloudflare
   Pages-hez vagy GitHub Pages-hez - onnantól az élő `/admin/` oldalon a
   bejelentkező gombra kattintva a szerkesztők a saját, itt regisztrált
   felhasználónevükkel és jelszavukkal léphetnek be.

## Napi használat

- **Zárolt fiók feloldása**: `https://<worker-url>/manage` → admin belépés →
  "Feloldás" gomb a zárolt sor mellett.
- **Új szerkesztő felvétele**: ugyanitt, az "Új szerkesztő felvétele" űrlappal
  (a szerkesztő az első belépéskor még nem tudja megváltoztatni a jelszavát -
  ha ezt szeretnéd, szólj, és beépítjük).

Helyben, localhoston futtatva (`npm run start`) továbbra sem kell
bejelentkezni - ott megmarad az egyszerű helyi szerkesztés.
