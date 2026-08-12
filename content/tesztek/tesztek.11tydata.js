module.exports = {
  layout: "review.njk",
  tags: ["teszt"],
  eleventyComputed: {
    // draft: true esetén a cikk oldala egyáltalán nem generálódik ki (nincs
    // publikus URL-je) - ez teszi lehetővé, hogy egy már korábban publikált,
    // fix permalinkes cikket is vissza lehessen tenni piszkozatba, nem csak
    // az újakat lehessen piszkozatként létrehozni.
    permalink: (data) => {
      if (data.draft) return false;
      return data.permalink || `/tesztek/${data.page.fileSlug}/`;
    },
  },
};
