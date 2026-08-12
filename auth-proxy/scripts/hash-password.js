#!/usr/bin/env node
/**
 * Segédszkript az első admin fiók (vagy bármelyik szerkesztő) KV-rekordjának
 * legenerálásához, ugyanazzal a PBKDF2-SHA256 (100 000 iteráció, 32 byte)
 * hash-eléssel, amit a Worker (src/index.js) is használ belépéskor.
 *
 * Használat:
 *   node scripts/hash-password.js <jelszo> [admin|editor]
 *
 * A kimenetet a wrangler KV feltöltő parancsba kell másolni (vagy a
 * Cloudflare dashboard KV szerkesztőjébe).
 */

const crypto = require("crypto");

// FONTOS: ennek pontosan egyeznie kell a src/index.js PBKDF2_ITERATIONS
// konstansával, különben a bootstrap fiók jelszava nem fog egyezni azzal,
// amit a Worker belépéskor kiszámol.
const PBKDF2_ITERATIONS = 100000;

const password = process.argv[2];
const role = process.argv[3] === "admin" ? "admin" : "editor";

if (!password) {
  console.error("Használat: node scripts/hash-password.js <jelszo> [admin|editor]");
  process.exit(1);
}

const salt = crypto.randomBytes(16);
const hash = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 32, "sha256");

const record = {
  saltHex: salt.toString("hex"),
  hashHex: hash.toString("hex"),
  role: role,
  failedAttempts: 0,
  locked: false,
};

const json = JSON.stringify(record);

console.log("KV rekord (" + role + "):\n");
console.log(json);
console.log("\nFeltöltés wrangler-rel (cseréld le a <felhasznalonev>-et):\n");
console.log(
  'npx wrangler kv key put "editor:<felhasznalonev>" \'' + json + "' --binding=EDITORS_KV --remote"
);
