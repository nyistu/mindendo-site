require("dotenv").config();
const EleventyFetch = require("@11ty/eleventy-fetch");

module.exports = function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy("css");
  eleventyConfig.addPassthroughCopy("img");
  eleventyConfig.addPassthroughCopy("admin");
  eleventyConfig.addPassthroughCopy("_headers");

  eleventyConfig.addFilter("prosConsList", function (arr) {
    return arr || [];
  });

  // A "teszt" tag-gel automatikusan létrejövő kollekciót felülírjuk, hogy a
  // piszkozatban (draft: true) lévő cikkek sehol ne jelenjenek meg a publikus
  // oldalon (listák, archívum, legjobbak, keresés, stb.) - a saját, egyedi
  // oldaluk generálását külön a content/tesztek/tesztek.11tydata.js
  // eleventyComputed.permalink-je tiltja le.
  eleventyConfig.addCollection("teszt", function (collectionApi) {
    return collectionApi.getFilteredByTag("teszt").filter((item) => !item.data.draft);
  });

  eleventyConfig.addFilter("byPlatform", function (posts, slug) {
    return (posts || []).filter((p) => p.data.platformSlug === slug);
  });

  eleventyConfig.addFilter("coverOrDefault", function (cover) {
    return cover || "/img/covers/default-cover.svg";
  });

  eleventyConfig.addFilter("upcoming", function (items) {
    const now = new Date();
    return (items || [])
      .filter((i) => i.releaseDate && new Date(i.releaseDate) >= now)
      .sort((a, b) => new Date(a.releaseDate) - new Date(b.releaseDate));
  });

  eleventyConfig.addFilter("postUrls", function (posts) {
    return (posts || []).map((p) => p.url);
  });

  // Rangsorolás pontszám szerint (csökkenő), holtverseny esetén a frissebb dátum nyer.
  // A "Legjobbak" listákhoz.
  eleventyConfig.addFilter("byRatingDesc", function (posts) {
    return (posts || [])
      .slice()
      .sort((a, b) => {
        const ratingDiff = (b.data.rating || 0) - (a.data.rating || 0);
        if (ratingDiff !== 0) return ratingDiff;
        return new Date(b.data.date) - new Date(a.data.date);
      });
  });

  const HUN_MONTHS = [
    "január", "február", "március", "április", "május", "június",
    "július", "augusztus", "szeptember", "október", "november", "december",
  ];

  // Archívum: tesztek csoportosítása év > hónap szerint, csökkenő időrendben.
  eleventyConfig.addFilter("groupByYearMonth", function (posts) {
    const sorted = (posts || [])
      .slice()
      .sort((a, b) => new Date(b.data.date) - new Date(a.data.date));

    const years = new Map();
    sorted.forEach((post) => {
      const d = new Date(post.data.date);
      const year = d.getFullYear();
      const month = d.getMonth();
      if (!years.has(year)) years.set(year, new Map());
      const months = years.get(year);
      if (!months.has(month)) months.set(month, []);
      months.get(month).push(post);
    });

    return Array.from(years.entries())
      .sort((a, b) => b[0] - a[0])
      .map(([year, months]) => ({
        year,
        months: Array.from(months.entries())
          .sort((a, b) => b[0] - a[0])
          .map(([month, monthPosts]) => ({
            month,
            monthLabel: HUN_MONTHS[month],
            posts: monthPosts,
          })),
      }));
  });

  // RAWG.io hivatalos, ingyenes API-ja (nem scraper) - átlagos játékidő + Metacritic.
  // Igényel egy RAWG_API_KEY környezeti változót (.env fájlban, ld. .env.example).
  // Ha nincs kulcs, vagy a lekérés bármiért nem sikerül, csendben üres stringet ad vissza,
  // hogy soha ne törje el a build-et.
  eleventyConfig.addAsyncFilter("rawgBadge", async function (query) {
    const apiKey = process.env.RAWG_API_KEY;
    if (!apiKey || !query) return "";
    try {
      const url =
        "https://api.rawg.io/api/games?key=" +
        encodeURIComponent(apiKey) +
        "&search=" +
        encodeURIComponent(query) +
        "&page_size=1";
      const data = await EleventyFetch(url, {
        duration: "30d",
        type: "json",
      });
      const game = data && data.results && data.results[0];
      if (!game) return "";

      const parts = [];
      if (game.playtime) {
        parts.push("~" + game.playtime + " óra átlagos végigjátszás");
      }
      if (game.metacritic) {
        parts.push("Metacritic: " + game.metacritic);
      }
      if (!parts.length) return "";

      return (
        '<span class="rawg-badge" title="Forrás: RAWG.io">' +
        parts.join(" · ") +
        "</span>"
      );
    } catch (e) {
      return "";
    }
  });

  return {
    dir: {
      input: ".",
      includes: "_includes",
      output: "dist",
    },
    templateFormats: ["njk", "md", "html"],
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk",
  };
};
