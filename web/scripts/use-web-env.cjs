const fs = require("node:fs");
const path = require("node:path");

const target = String(process.argv[2] || "").trim().toLowerCase();
const presets = {
  local: ".env.local.local",
  server: ".env.local.server",
};

if (!Object.hasOwn(presets, target)) {
  console.error("Usage: node scripts/use-web-env.cjs <local|server>");
  process.exit(1);
}

const webRoot = path.resolve(__dirname, "..");
const source = path.join(webRoot, presets[target]);
const destination = path.join(webRoot, ".env.local");

if (!fs.existsSync(source)) {
  console.error(`Missing ${presets[target]}`);
  process.exit(1);
}

fs.copyFileSync(source, destination);
console.log(`Using ${target} web env: ${presets[target]} -> .env.local`);
