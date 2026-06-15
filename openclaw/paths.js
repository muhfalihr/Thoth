// paths.js — ONE place that decides where scripts write, so nothing litters the
// workspace root. Convention (matches the google-trends skill that predates this):
//   output/            → all JSON artifacts (content-sets, url lists, trends)
//   output/crops/      → all crop PNGs (comment crops, vision crops)
// Use outPath()/cropPath() for new files; both auto-create their dir.

const fs = require('fs');
const path = require('path');

const WORKSPACE = __dirname;
const OUTPUT_DIR = path.join(WORKSPACE, 'output');
const CROPS_DIR = path.join(OUTPUT_DIR, 'crops');

const ensureDir = d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); };

// Resolve a name into output/. If `name` is already an absolute path (caller passed
// an explicit destination), honour it untouched.
const outPath = name => {
  if (name && path.isAbsolute(name)) return name;
  ensureDir(OUTPUT_DIR);
  return path.join(OUTPUT_DIR, name);
};

const cropPath = name => { ensureDir(CROPS_DIR); return path.join(CROPS_DIR, name); };

module.exports = { WORKSPACE, OUTPUT_DIR, CROPS_DIR, ensureDir, outPath, cropPath };
