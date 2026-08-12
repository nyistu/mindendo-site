/**
 * Mindendo saját belépéses (felhasználónév + jelszó) auth proxy Decap CMS-hez,
 * Cloudflare Workers + KV segítségével. NEM GitHub OAuth-ot használ - a
 * szerkesztők nem a saját GitHub-fiókjukkal, hanem egy itt regisztrált
 * felhasználónévvel és jelszóval lépnek be.
 *
 * Hogyan működik:
 *   1. GET  /auth           -> a Decap CMS popupja ezt nyitja meg, ez adja
 *                              vissza a bejelentkező űrlapot (nem redirectel
 *                              GitHubra, mint a valódi OAuth-nál).
 *   2. POST /login          -> ellenőrzi a felhasználónevet/jelszót a KV
 *                              tárolóban lévő rekord alapján, számolja a
 *                              sikertelen próbálkozásokat, zárol az ötödik
 *                              után. Sikeres belépésnél egyetlen, közösen
 *                              használt GitHub PAT-ot ad vissza - ezt a Decap
 *                              CMS pontosan úgy használja, mintha valódi
 *                              GitHub OAuth tokent kapott volna.
 *   3. GET/POST /manage*    -> admin felület: szerkesztők listázása, zárolt
 *                              fiókok feloldása, új szerkesztő felvétele.
 *                              Csak "admin" szerepkörű fiókkal érhető el.
 *
 * Biztonsági intézkedések:
 *   - CSRF-védelem mind a Decap popup bejelentkezésen (/auth -> /login), mind
 *     a /manage* admin űrlapokon: rövid élettartamú, HttpOnly sütiben tárolt
 *     token, amit a szervernek vissza kell kapnia az űrlap mezőjében.
 *   - Fiókzárolás 5 sikertelen próbálkozás után, csak admin tudja feloldani.
 *   - Időzítés-alapú felhasználónév-kitalálás elleni védelem: nem létező
 *     felhasználónévnél is lefuttatunk egy "üres" jelszó-ellenőrzést, hogy a
 *     válaszidőből ne lehessen kikövetkeztetni, létezik-e egy adott fiók.
 *   - Alapvető biztonsági HTTP fejlécek minden válaszon.
 *   - postMessage csak az ALLOWED_ORIGINS listában szereplő originnek megy.
 *
 * Szükséges Worker secretek (`npx wrangler secret put NÉV`):
 *   GITHUB_PAT       - finomszemcsés GitHub Personal Access Token, KIZÁRÓLAG
 *                      a mindendo-site repóra, Contents: Read and write
 *                      jogosultsággal.
 *   SESSION_SECRET   - tetszőleges hosszú, véletlen string az admin
 *                      munkamenet-süti aláírásához.
 *   ALLOWED_ORIGINS  - vesszővel elválasztott lista azokról az originekről,
 *                      ahonnan a Decap CMS popup nyílhat, pl.
 *                      "https://mindendo.hu,https://mindendo-site.pages.dev"
 *
 * Szükséges KV namespace (wrangler.toml-ben "EDITORS_KV" néven kötve):
 *   Kulcsok "editor:<felhasznalonev>" formátumban, érték:
 *   { saltHex, hashHex, role: "editor"|"admin", failedAttempts, locked }
 *
 * Az első admin fiók feltöltéséhez ld. auth-proxy/scripts/hash-password.js
 * és az auth-proxy/README.md-t.
 */

const MAX_FAILED_ATTEMPTS = 5;
const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 8; // 8 óra
const MIN_PASSWORD_LENGTH = 8;
const PBKDF2_ITERATIONS = 100000;

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

// ---------- segédfüggvények ----------

function parseCookie(header, name) {
  if (!header) return null;
  const match = header.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return match ? decodeURIComponent(match[1]) : null;
}

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex) {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) {
    arr[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return arr;
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

async function derivePbkdf2Hex(password, saltBytes) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return bytesToHex(new Uint8Array(bits));
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hashHex = await derivePbkdf2Hex(password, salt);
  return { saltHex: bytesToHex(salt), hashHex };
}

async function verifyPassword(password, saltHex, hashHex) {
  const computed = await derivePbkdf2Hex(password, hexToBytes(saltHex));
  return timingSafeEqual(computed, hashHex);
}

// Fix "dummy" só/hash pár, amit akkor használunk, ha a felhasználónév nem
// létezik - így a PBKDF2 számítás (és ezzel a válaszidő) minden esetben
// lefut, nem csak létező fióknál. Enélkül a válaszidőből meg lehetne
// különböztetni a "nincs ilyen felhasználó" és a "rossz jelszó" eseteket.
const DUMMY_SALT_HEX = bytesToHex(new Uint8Array(16));
const DUMMY_HASH_HEX = "0".repeat(64);

async function hmacHex(value, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(value));
  return bytesToHex(new Uint8Array(sig));
}

function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

function jsonResponse(obj, status, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign(
      { "Content-Type": "application/json;charset=UTF-8" },
      SECURITY_HEADERS,
      extraHeaders || {}
    ),
  });
}

function htmlResponse(html, status, extraHeaders) {
  return new Response(html, {
    status: status || 200,
    headers: Object.assign(
      { "Content-Type": "text/html;charset=UTF-8" },
      SECURITY_HEADERS,
      extraHeaders || {}
    ),
  });
}

function redirectResponse(location, extraHeaders) {
  return new Response(null, {
    status: 302,
    headers: Object.assign({ Location: location }, SECURITY_HEADERS, extraHeaders || {}),
  });
}

// ---------- session (csak az admin /manage felülethez) ----------

async function makeSessionCookieValue(username, role, secret) {
  const exp = Date.now() + SESSION_MAX_AGE_MS;
  const payload = username + "|" + role + "|" + exp;
  const payloadB64 = btoa(payload);
  const sig = await hmacHex(payloadB64, secret);
  return payloadB64 + "." + sig;
}

async function verifySessionCookieValue(cookieValue, secret) {
  if (!cookieValue) return null;
  const parts = cookieValue.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  const expectedSig = await hmacHex(payloadB64, secret);
  if (!timingSafeEqual(sig, expectedSig)) return null;
  let payload;
  try {
    payload = atob(payloadB64);
  } catch (e) {
    return null;
  }
  const bits = payload.split("|");
  if (bits.length !== 3) return null;
  const [username, role, expStr] = bits;
  const exp = Number(expStr);
  if (!exp || Date.now() > exp) return null;
  return { username, role };
}

async function getAdminSession(request, env) {
  const cookie = parseCookie(request.headers.get("Cookie"), "admin_session");
  const session = await verifySessionCookieValue(cookie, env.SESSION_SECRET);
  if (!session || session.role !== "admin") return null;
  return session;
}

// CSRF-ellenőrzés a /manage* űrlapokhoz: a GET /manage mindig kiad egy friss
// "manage_csrf" sütit, amit az űrlapok rejtett mezőként visszaküldenek.
function checkManageCsrf(request, form) {
  const cookieVal = parseCookie(request.headers.get("Cookie"), "manage_csrf");
  const fieldVal = form.get("csrf");
  return !!cookieVal && !!fieldVal && cookieVal === fieldVal;
}

// ---------- KV-alapú felhasználókezelés + zárolás ----------

function editorKey(username) {
  return "editor:" + String(username || "").trim().toLowerCase();
}

async function getEditor(env, username) {
  const raw = await env.EDITORS_KV.get(editorKey(username));
  return raw ? JSON.parse(raw) : null;
}

async function putEditor(env, username, record) {
  await env.EDITORS_KV.put(editorKey(username), JSON.stringify(record));
}

// Közös belépés-ellenőrzés: ezt használja mind a Decap popup (/login), mind
// az admin felület (/manage/login) - így egy adott fiók sikertelen
// próbálkozásai a két belépési ponton is közösen számolódnak.
async function attemptLogin(env, username, password) {
  if (!username || !password) {
    return { ok: false, error: "Hiányzó felhasználónév vagy jelszó." };
  }

  const record = await getEditor(env, username);
  if (!record) {
    // Lefuttatjuk ugyanazt a drága PBKDF2 számítást akkor is, ha a
    // felhasználónév nem létezik, hogy a válaszidőből ne lehessen
    // kikövetkeztetni a fiók létezését. Az eredményt eldobjuk.
    await verifyPassword(password, DUMMY_SALT_HEX, DUMMY_HASH_HEX);
    return { ok: false, error: "Hibás felhasználónév vagy jelszó." };
  }

  if (record.locked) {
    return {
      ok: false,
      error:
        "Ez a fiók zárolva van a túl sok sikertelen belépési kísérlet miatt. Kérj feloldást az adminisztrátortól.",
    };
  }

  const valid = await verifyPassword(password, record.saltHex, record.hashHex);
  if (!valid) {
    record.failedAttempts = (record.failedAttempts || 0) + 1;
    if (record.failedAttempts >= MAX_FAILED_ATTEMPTS) {
      record.locked = true;
    }
    await putEditor(env, username, record);
    return {
      ok: false,
      error: record.locked
        ? "Túl sok sikertelen próbálkozás - a fiók zárolva. Kérj feloldást az adminisztrátortól."
        : "Hibás felhasználónév vagy jelszó.",
    };
  }

  record.failedAttempts = 0;
  await putEditor(env, username, record);
  return { ok: true, username: editorKey(username).replace(/^editor:/, ""), role: record.role || "editor" };
}

// ---------- HTML nézetek ----------

// Közös stílus a két kis, középre igazított bejelentkező-dobozhoz
// (Decap popup és admin /manage belépés) - korábban ez a blokk szó szerint
// duplikálva volt a két HTML-generáló függvényben.
const AUTH_FORM_STYLES =
  "body{font-family:Arial,sans-serif;background:#160d2c;color:#f2eefb;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}" +
  "form{background:#241546;padding:2rem;border-radius:12px;border:1px solid #3a2266;width:280px;}" +
  "h2{margin-top:0;font-size:1.1rem;}" +
  "input{width:100%;box-sizing:border-box;margin:.35rem 0 1rem;padding:.6rem;border-radius:6px;border:1px solid #3a2266;background:#160d2c;color:#f2eefb;font-size:1rem;}" +
  "button{width:100%;padding:.6rem;border:none;border-radius:6px;background:#e53946;color:#fff;font-weight:700;font-size:1rem;cursor:pointer;}" +
  ".error{color:#ffb703;font-size:.85rem;margin-bottom:.6rem;min-height:1.2em;}";

function loginFormHtml(csrfToken, allowedOrigins, errorMessage) {
  return (
    "<!doctype html><html lang=\"hu\"><head><meta charset=\"utf-8\">" +
    "<title>Mindendo szerkesztői belépés</title><style>" +
    AUTH_FORM_STYLES +
    "</style></head><body>" +
    "<form id=\"login-form\">" +
    "<h2>Mindendo szerkesztői belépés</h2>" +
    "<div class=\"error\" id=\"login-error\">" +
    escapeHtml(errorMessage || "") +
    "</div>" +
    "<input type=\"text\" name=\"username\" placeholder=\"Felhasználónév\" autocomplete=\"username\" required>" +
    "<input type=\"password\" name=\"password\" placeholder=\"Jelszó\" autocomplete=\"current-password\" required>" +
    "<input type=\"hidden\" name=\"csrf\" value=\"" +
    escapeHtml(csrfToken) +
    "\">" +
    "<button type=\"submit\">Belépés</button>" +
    "</form>" +
    "<script>" +
    "(function(){" +
    "var form=document.getElementById('login-form');" +
    "var errorBox=document.getElementById('login-error');" +
    "var allowed=" +
    JSON.stringify(allowedOrigins) +
    ";" +
    "form.addEventListener('submit',function(e){" +
    "e.preventDefault();" +
    "errorBox.textContent='';" +
    "var data={username:form.username.value,password:form.password.value,csrf:form.csrf.value};" +
    "fetch('/login',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)})" +
    ".then(function(r){return r.json();})" +
    ".then(function(res){" +
    "if(!res.ok){errorBox.textContent=res.error||'Sikertelen belépés.';return;}" +
    "var payload=JSON.stringify({token:res.token,provider:'github'});" +
    "function receiveMessage(ev){" +
    "if(allowed.indexOf(ev.origin)===-1){return;}" +
    "window.opener.postMessage('authorization:github:success:'+payload,ev.origin);" +
    "window.removeEventListener('message',receiveMessage);" +
    "}" +
    "window.addEventListener('message',receiveMessage,false);" +
    "window.opener.postMessage('authorizing:github','*');" +
    "})" +
    ".catch(function(){errorBox.textContent='Hálózati hiba, próbáld újra.';});" +
    "});" +
    "})();" +
    "</script>" +
    "</body></html>"
  );
}

function manageLoginHtml(errorMessage, csrfToken) {
  return (
    "<!doctype html><html lang=\"hu\"><head><meta charset=\"utf-8\">" +
    "<title>Mindendo admin</title><style>" +
    AUTH_FORM_STYLES +
    "</style></head><body>" +
    "<form method=\"POST\" action=\"/manage/login\">" +
    "<h2>Mindendo admin belépés</h2>" +
    "<div class=\"error\">" +
    escapeHtml(errorMessage || "") +
    "</div>" +
    "<input type=\"text\" name=\"username\" placeholder=\"Felhasználónév\" autocomplete=\"username\" required>" +
    "<input type=\"password\" name=\"password\" placeholder=\"Jelszó\" autocomplete=\"current-password\" required>" +
    "<input type=\"hidden\" name=\"csrf\" value=\"" +
    escapeHtml(csrfToken || "") +
    "\">" +
    "<button type=\"submit\">Belépés</button>" +
    "</form></body></html>"
  );
}

async function manageDashboardHtml(env, notice, csrfToken) {
  const list = await env.EDITORS_KV.list({ prefix: "editor:" });
  const rows = [];
  for (const key of list.keys) {
    const raw = await env.EDITORS_KV.get(key.name);
    if (!raw) continue;
    const record = JSON.parse(raw);
    const username = key.name.replace(/^editor:/, "");
    rows.push(
      "<tr>" +
        "<td>" + escapeHtml(username) + "</td>" +
        "<td>" + escapeHtml(record.role || "editor") + "</td>" +
        "<td>" + (record.locked ? "🔒 zárolva" : "✅ aktív") + "</td>" +
        "<td>" + (record.failedAttempts || 0) + "</td>" +
        "<td>" +
        (record.locked
          ? "<form method=\"POST\" action=\"/manage/unlock\" style=\"display:inline\">" +
            "<input type=\"hidden\" name=\"username\" value=\"" + escapeHtml(username) + "\">" +
            "<input type=\"hidden\" name=\"csrf\" value=\"" + escapeHtml(csrfToken || "") + "\">" +
            "<button type=\"submit\">Feloldás</button></form>"
          : "") +
        "</td>" +
      "</tr>"
    );
  }

  return (
    "<!doctype html><html lang=\"hu\"><head><meta charset=\"utf-8\">" +
    "<title>Mindendo admin</title><style>" +
    "body{font-family:Arial,sans-serif;background:#160d2c;color:#f2eefb;margin:0;padding:2rem;}" +
    "h1{font-size:1.4rem;} h2{font-size:1.1rem;margin-top:2.5rem;}" +
    "table{border-collapse:collapse;width:100%;max-width:640px;}" +
    "th,td{text-align:left;padding:.5rem .8rem;border-bottom:1px solid #3a2266;font-size:.9rem;}" +
    "form.add{background:#241546;padding:1.2rem 1.5rem;border-radius:10px;border:1px solid #3a2266;max-width:320px;}" +
    "input,select{width:100%;box-sizing:border-box;margin:.3rem 0 .9rem;padding:.5rem;border-radius:6px;border:1px solid #3a2266;background:#160d2c;color:#f2eefb;}" +
    "button{padding:.4rem .9rem;border:none;border-radius:6px;background:#e53946;color:#fff;font-weight:700;cursor:pointer;}" +
    ".notice{color:#3ecf8e;margin-bottom:1rem;}" +
    ".error{color:#ffb703;margin-bottom:1rem;}" +
    "a.logout{color:#b8aed6;font-size:.85rem;}" +
    "</style></head><body>" +
    "<h1>Mindendo - szerkesztők kezelése</h1>" +
    (notice ? "<div class=\"notice\">" + escapeHtml(notice) + "</div>" : "") +
    "<table><thead><tr><th>Felhasználónév</th><th>Szerep</th><th>Állapot</th><th>Sikertelen próbálkozás</th><th></th></tr></thead>" +
    "<tbody>" + rows.join("") + "</tbody></table>" +
    "<h2>Új szerkesztő felvétele</h2>" +
    "<form class=\"add\" method=\"POST\" action=\"/manage/add-editor\">" +
    "<input type=\"text\" name=\"username\" placeholder=\"Felhasználónév\" required>" +
    "<input type=\"password\" name=\"password\" placeholder=\"Kezdő jelszó (min. " + MIN_PASSWORD_LENGTH + " karakter)\" minlength=\"" + MIN_PASSWORD_LENGTH + "\" required>" +
    "<select name=\"role\"><option value=\"editor\">Szerkesztő</option><option value=\"admin\">Admin</option></select>" +
    "<input type=\"hidden\" name=\"csrf\" value=\"" + escapeHtml(csrfToken || "") + "\">" +
    "<button type=\"submit\">Hozzáadás</button>" +
    "</form>" +
    "<p style=\"margin-top:2rem;\"><form method=\"POST\" action=\"/manage/logout\">" +
    "<input type=\"hidden\" name=\"csrf\" value=\"" + escapeHtml(csrfToken || "") + "\">" +
    "<button type=\"submit\" style=\"background:transparent;border:1px solid #3a2266;color:#b8aed6;\">Kijelentkezés</button></form></p>" +
    "</body></html>"
  );
}

// ---------- fő request handler ----------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // --- Decap CMS popup: bejelentkező űrlap ---
    if (url.pathname === "/auth" && request.method === "GET") {
      const csrf = crypto.randomUUID();
      const allowedOrigins = (env.ALLOWED_ORIGINS || "")
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean);

      return htmlResponse(loginFormHtml(csrf, allowedOrigins, ""), 200, {
        "Set-Cookie":
          "login_csrf=" + csrf + "; HttpOnly; Secure; SameSite=Lax; Max-Age=600; Path=/",
      });
    }

    // --- Decap CMS popup: belépés feldolgozása ---
    if (url.pathname === "/login" && request.method === "POST") {
      const csrfCookie = parseCookie(request.headers.get("Cookie"), "login_csrf");
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return jsonResponse({ ok: false, error: "Hibás kérés." }, 400);
      }

      if (!body || !body.csrf || !csrfCookie || body.csrf !== csrfCookie) {
        return jsonResponse(
          { ok: false, error: "Lejárt munkamenet - tölts be újra az oldalt." },
          400
        );
      }

      const result = await attemptLogin(env, body.username, body.password);
      if (!result.ok) {
        return jsonResponse(result, 401);
      }

      if (!env.GITHUB_PAT) {
        return jsonResponse(
          { ok: false, error: "A szerver nincs teljesen beállítva (hiányzó GITHUB_PAT)." },
          500
        );
      }

      return jsonResponse(
        { ok: true, token: env.GITHUB_PAT },
        200,
        {
          "Set-Cookie": "login_csrf=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/",
        }
      );
    }

    // --- Admin felület: irányítópult / bejelentkező form (mindig friss CSRF-fel) ---
    if (url.pathname === "/manage" && request.method === "GET") {
      const csrf = crypto.randomUUID();
      const cookieHeader = {
        "Set-Cookie":
          "manage_csrf=" + csrf + "; HttpOnly; Secure; SameSite=Lax; Max-Age=1800; Path=/",
      };
      const err = url.searchParams.get("err") || "";
      const notice = url.searchParams.get("notice") || "";

      const session = await getAdminSession(request, env);
      if (!session) {
        return htmlResponse(manageLoginHtml(err, csrf), 200, cookieHeader);
      }
      return htmlResponse(await manageDashboardHtml(env, notice || err, csrf), 200, cookieHeader);
    }

    // --- Admin felület: belépés ---
    if (url.pathname === "/manage/login" && request.method === "POST") {
      const form = await request.formData();

      if (!checkManageCsrf(request, form)) {
        return redirectResponse(
          "/manage?err=" + encodeURIComponent("Lejárt űrlap - tölts be újra az oldalt.")
        );
      }

      const username = form.get("username");
      const password = form.get("password");
      const result = await attemptLogin(env, username, password);

      if (!result.ok || result.role !== "admin") {
        const message = result.ok ? "Ehhez a fiókhoz nincs admin jogosultság." : result.error;
        return redirectResponse("/manage?err=" + encodeURIComponent(message));
      }

      const cookieValue = await makeSessionCookieValue(
        result.username,
        result.role,
        env.SESSION_SECRET
      );
      return redirectResponse("/manage", {
        "Set-Cookie":
          "admin_session=" +
          cookieValue +
          "; HttpOnly; Secure; SameSite=Lax; Max-Age=" +
          Math.floor(SESSION_MAX_AGE_MS / 1000) +
          "; Path=/",
      });
    }

    // --- Admin felület: kilépés ---
    if (url.pathname === "/manage/logout" && request.method === "POST") {
      const form = await request.formData();
      if (!checkManageCsrf(request, form)) {
        return redirectResponse("/manage");
      }
      return redirectResponse("/manage", {
        "Set-Cookie": "admin_session=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/",
      });
    }

    // --- Admin felület: zárolt fiók feloldása ---
    if (url.pathname === "/manage/unlock" && request.method === "POST") {
      const session = await getAdminSession(request, env);
      if (!session) return htmlResponse(manageLoginHtml("", ""), 401);

      const form = await request.formData();
      if (!checkManageCsrf(request, form)) {
        return redirectResponse(
          "/manage?err=" + encodeURIComponent("Lejárt űrlap - próbáld újra.")
        );
      }

      const targetUsername = form.get("username");
      const record = await getEditor(env, targetUsername);
      if (record) {
        record.locked = false;
        record.failedAttempts = 0;
        await putEditor(env, targetUsername, record);
      }

      return redirectResponse(
        "/manage?notice=" + encodeURIComponent("Fiók feloldva: " + targetUsername)
      );
    }

    // --- Admin felület: új szerkesztő felvétele ---
    if (url.pathname === "/manage/add-editor" && request.method === "POST") {
      const session = await getAdminSession(request, env);
      if (!session) return htmlResponse(manageLoginHtml("", ""), 401);

      const form = await request.formData();
      if (!checkManageCsrf(request, form)) {
        return redirectResponse(
          "/manage?err=" + encodeURIComponent("Lejárt űrlap - próbáld újra.")
        );
      }

      const username = (form.get("username") || "").toString().trim();
      const password = (form.get("password") || "").toString();
      const role = form.get("role") === "admin" ? "admin" : "editor";

      if (!username || !password) {
        return redirectResponse(
          "/manage?err=" + encodeURIComponent("Hiányzó felhasználónév vagy jelszó.")
        );
      }
      if (password.length < MIN_PASSWORD_LENGTH) {
        return redirectResponse(
          "/manage?err=" +
            encodeURIComponent("A jelszónak legalább " + MIN_PASSWORD_LENGTH + " karakter hosszúnak kell lennie.")
        );
      }

      const { saltHex, hashHex } = await hashPassword(password);
      await putEditor(env, username, {
        saltHex,
        hashHex,
        role,
        failedAttempts: 0,
        locked: false,
      });

      return redirectResponse(
        "/manage?notice=" + encodeURIComponent("Szerkesztő felvéve: " + username)
      );
    }

    return new Response("Mindendo auth proxy fut.", { status: 200, headers: SECURITY_HEADERS });
  },
};
