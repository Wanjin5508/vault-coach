import { readFileSync, writeFileSync } from "fs";

const targetVersion = process.env.npm_package_version;

// 从 manifest.json 读取最低 Obsidian 版本，并把插件版本更新为 npm 目标版本。
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t"));

// versions.json 的键是插件版本，不是最低 Obsidian 版本；每次发版都必须写入目标版本。
const versions = JSON.parse(readFileSync('versions.json', 'utf8'));
if (versions[targetVersion] !== minAppVersion) {
    versions[targetVersion] = minAppVersion;
    writeFileSync('versions.json', JSON.stringify(versions, null, '\t'));
}
