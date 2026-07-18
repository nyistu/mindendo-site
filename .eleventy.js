require("dotenv").config();
const EleventyFetch = require("@11ty/eleventy-fetch");

module.exports = function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy("css");
  eleventyConfig.addPassthroughCopy("img");
  eleventyConfig.addPassthroughCopy("admin");

  eleventyConfig.addFilter("prosConsList", function (arr) {
    return arr || [];
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
