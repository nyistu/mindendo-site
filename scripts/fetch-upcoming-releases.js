#!/usr/bin/env node
/**
 * Automatikusan felkutatja a közelgő Nintendo Switch megjelenéseket a RAWG.io
 * API-ból, és hozzáadja őket a "_data/hamarosan.json" fájlhoz, ha még nem
 * szerepelnek ott, és korábban sem írtunk róluk tesztet. Emellett kiszűri a
 * hamarosan.json-ból azokat a tételeket, amiknek már elmúlt a megjelenési
 * dátuma.
 *
 * Csak az ütemezett (vagy manuálisan indított) GitHub Actions futásnál
 * hívódik meg, ld. .github/workflows/deploy.yml - nem fut le minden
 * tartalom-push-nál.
 *
 * FONTOS: ez egy "best effort" automatizálás. A RAWG adatai nem mindig
 * pontosak vagy teljesek (pl. Switch 2-exkluzívokat gyakran csak
 * "Nintendo Switch" platformként ismeri fel, trailer linket nem ad), ezért
 * minden automatikusan felvett tételt jelölünk egy megjegyzésben, és érdemes
 * utólag átnézni/kiegészíteni a szerkesztői felületen.
 *
 * Soha nem töri el a build-et: ha a RAWG lekérés hibázik vagy nincs API
 * kulcs, egyszerűen nem történik változás.
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");

const RAWG_API_KEY = process.env.RAWG_API_KEY;
const HAMAROSAN_PATH = path.join(__dirname, "..", "_data", "hamarosan.json");
const TESZTEK_DIR = path.join(__dirname, "..", "content", "tesztek");
const MONTHS_AHEAD = 6;
const MAX_NEW_ITEMS_PER_RUN = 15; // védőháló, nehogy egyszerre árasszon el a lista

function normalizeTitle(title) {
  return String(title || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function loadHamarosan() {
  if (!fs.existsSync(HAMAROSAN_PATH)) return { items: [] };
  const data = JSON.parse(fs.readFileSync(HAMAROSAN_PATH, "utf8"));
  if (!Array.isArray(data.items)) data.items = [];
  return data;
}

function loadReviewedTitles() {
  const titles = new Set();
  if (!fs.existsSync(TESZTEK_DIR)) return titles;

  fs.readdirSync(TESZTEK_DIR)
    .filter((f) => f.endsWith(".md"))
    .forEach((f) => {
      const raw = fs.readFileSync(path.join(TESZTEK_DIR, f), "utf8");
      const titleMatch = raw.match(/^title:\s*"?(.*?)"?\s*$/m);
      const rawgMatch = raw.match(/^rawgQuery:\s*"?(.*?)"?\s*$/m);
      if (titleMatch) titles.add(normalizeTitle(titleMatch[1]));
      if (rawgMatch) titles.add(normalizeTitle(rawgMatch[1]));
    });

  return titles;
}

async function resolveSwitchPlatformId() {
  const res = await fetch(
    "https://api.rawg.io/api/platforms?key=" + encodeURIComponent(RAWG_API_KEY)
  );
  if (!res.ok) throw new Error("RAWG /platforms hiba: " + res.status);
  const data = await res.json();
  const match = (data.results || []).find(
    (p) => p.slug === "nintendo-switch" || /nintendo switch/i.test(p.name || "")
  );
  if (!match) throw new Error("Nem található 'Nintendo Switch' platform a RAWG válaszban.");
  return match.id;
}

async function fetchUpcomingFromRawg(platformId) {
  const today = new Date();
  const future = new Date();
  future.setMonth(future.getMonth() + MONTHS_AHEAD);
  const fmt = (d) => d.toISOString().slice(0, 10);

  const url =
    "https://api.rawg.io/api/games?key=" +
    encodeURIComponent(RAWG_API_KEY) +
    "&platforms=" +
    platformId +
    "&dates=" +
    fmt(today) +
    "," +
    fmt(future) +
    "&ordering=-added&page_size=40";

  const res = await fetch(url);
  if (!res.ok) throw new Error("RAWG /games hiba: " + res.status);
  const data = await res.json();
  return (data.results || []).filter((g) => !g.tba && g.released);
}

async function main() {
  if (!RAWG_API_KEY) {
    console.log("Nincs RAWG_API_KEY beállítva - kihagyva, nincs változás.");
    return;
  }

  const hamarosan = loadHamarosan();
  const reviewedTitles = loadReviewedTitles();

  // 1. Lejárt tételek kiszűrése a hamarosan.json-ból.
  const now = new Date();
  const beforeCount = hamarosan.items.length;
  hamarosan.items = hamarosan.items.filter(
    (item) => !item.releaseDate || new Date(item.releaseDate) >= now
  );
  const removedCount = beforeCount - hamarosan.items.length;

  // A cikkek címe stílusos ("Játék neve - kritika/vélemény szöveg"), nem
  // tiszta játéknév, ezért nem elég a pontos egyezés: azt nézzük, hogy a
  // RAWG-tól kapott játéknév részstringként szerepel-e egy már ismert
  // címben (vagy fordítva), így a "Kirby Super Star" a "Kirby Super Star -
  // retro gyöngyszem..." cikkcímmel is duplikátumnak számít.
  const knownTitles = [
    ...hamarosan.items.map((i) => normalizeTitle(i.title)),
    ...reviewedTitles,
  ].filter(Boolean);

  function isKnownTitle(gameName) {
    const norm = normalizeTitle(gameName);
    if (!norm) return false;
    return knownTitles.some(
      (known) => known === norm || known.includes(norm) || norm.includes(known)
    );
  }

  // 2. Új, közelgő Switch-megjelenések lekérése és felvétele.
  let addedCount = 0;
  try {
    const platformId = await resolveSwitchPlatformId();
    const upcoming = await fetchUpcomingFromRawg(platformId);

    for (const game of upcoming) {
      if (addedCount >= MAX_NEW_ITEMS_PER_RUN) break;

      if (isKnownTitle(game.name)) continue;
      knownTitles.push(normalizeTitle(game.name));

      hamarosan.items.push({
        title: game.name,
        platform: "Nintendo Switch",
        releaseDate: game.released,
        expectedLabel: game.released,
        trailerId: "",
        note:
          "Automatikusan felvéve a RAWG.io alapján - ellenőrizd a platformot (lehet Switch 2-exkluzív is), és ha van, tölts fel trailert.",
      });
      addedCount++;
    }
  } catch (err) {
    console.log("RAWG lekérés sikertelen, csak a lejárt tételek eltávolítása történt meg:", err.message);
  }

  if (addedCount === 0 && removedCount === 0) {
    console.log("Nincs változás.");
    return;
  }

  fs.writeFileSync(HAMAROSAN_PATH, JSON.stringify(hamarosan, null, 2) + "\n");
  console.log(
    `Kész: ${addedCount} új tétel hozzáadva, ${removedCount} lejárt tétel eltávolítva.`
  );
}

main().catch((err) => {
  console.error("Váratlan hiba a fetch-upcoming-releases.js-ben:", err);
  // Szándékosan 0-val lépünk ki, hogy ez soha ne törje el az ütemezett build-et.
  process.exit(0);
});
