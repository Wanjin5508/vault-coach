import { readFileSync, statSync } from "node:fs";

const maxMainBytes = 4_500_000;
const requiredAssets = ["main.js", "manifest.json", "styles.css"];
const failures = [];

for (const asset of requiredAssets) {
    try {
        statSync(asset);
    } catch {
        failures.push(`Missing release asset: ${asset}`);
    }
}

if (failures.length === 0) {
    const mainBytes = statSync("main.js").size;
    const mainSource = readFileSync("main.js", "utf8");
    if (mainBytes > maxMainBytes) {
        failures.push(`main.js is ${mainBytes} bytes; budget is ${maxMainBytes} bytes.`);
    }
    if (mainSource.includes("__VAULT_COACH_ORT_WASM_BASE64__")) {
        failures.push("main.js still contains the removed ORT WASM Base64 marker.");
    }
    if (!mainSource.includes("vault-coach-local-ai-runtime-v1")) {
        failures.push("main.js does not contain the pinned local AI runtime policy.");
    }
    console.log(`main.js: ${mainBytes} bytes (budget ${maxMainBytes}).`);
}

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const versions = JSON.parse(readFileSync("versions.json", "utf8"));
if (packageJson.version !== manifest.version) {
    failures.push(`package.json ${packageJson.version} != manifest.json ${manifest.version}`);
}
if (versions[manifest.version] !== manifest.minAppVersion) {
    failures.push(`versions.json does not map ${manifest.version} to ${manifest.minAppVersion}.`);
}

if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    process.exit(1);
}
console.log("Release asset verification passed.");
