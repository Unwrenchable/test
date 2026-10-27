"use strict";

const fs = require("fs");
const path = require("path");

const FEATURE_TO_ANCHOR = {
  localnet: "localnet",
  devnet: "devnet",
  mainnet: "mainnet",
};

function parseDeclareIds(src) {
  const re =
    /#\[cfg\(feature = "(localnet|devnet|mainnet)"\)\]\s*declare_id!\("([1-9A-HJ-NP-Za-km-z]+)"\);/g;
  const found = {};
  for (const match of src.matchAll(re)) found[match[1]] = match[2];
  return found;
}

function parseAnchorIds(src) {
  const found = {};
  for (const section of Object.values(FEATURE_TO_ANCHOR)) {
    const re = new RegExp(
      "\\[programs\\." +
        section.replace("-", "\\-") +
        "\\][^\\[]*?fizzcaps_onchain\\s*=\\s*\"([^\"]+)\"",
    );
    const match = src.match(re);
    if (!match) throw new Error(`Anchor.toml is missing [programs.${section}] fizzcaps_onchain`);
    found[section] = match[1];
  }
  return found;
}

function checkDeclareIds(libSrc, anchorSrc) {
  const declared = parseDeclareIds(libSrc);
  const anchor = parseAnchorIds(anchorSrc);
  const errors = [];
  for (const [feature, section] of Object.entries(FEATURE_TO_ANCHOR)) {
    if (!declared[feature]) errors.push(`declare_id! missing for feature ${feature}`);
    else if (declared[feature] !== anchor[section]) {
      errors.push(
        `${feature}: declare_id! is ${declared[feature]} but Anchor.toml [programs.${section}] is ${anchor[section]}`,
      );
    }
  }
  if (errors.length) {
    const error = new Error(errors.join("\n"));
    error.errors = errors;
    throw error;
  }
  return { declared, anchor };
}

function main() {
  const root = path.resolve(__dirname, "..");
  const libSrc = fs.readFileSync(
    path.join(root, "programs/fizzcaps-onchain/src/lib.rs"),
    "utf8",
  );
  const anchorSrc = fs.readFileSync(path.join(root, "Anchor.toml"), "utf8");
  const result = checkDeclareIds(libSrc, anchorSrc);
  for (const [feature, section] of Object.entries(FEATURE_TO_ANCHOR)) {
    console.log(`${feature} == [programs.${section}] == ${result.declared[feature]}`);
  }
}

module.exports = { parseDeclareIds, parseAnchorIds, checkDeclareIds, FEATURE_TO_ANCHOR };

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
