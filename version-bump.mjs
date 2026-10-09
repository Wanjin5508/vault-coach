import { readFileSync, writeFileSync } from "fs";

const targetVersion = process.env.npm_package_version;

// 从 manifest.json 读取最低 Obsidian 版本，并把插件版本更新为 npm 目标版本。
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t"));

// 当前兼容逻辑仅在该最低 Obsidian 版本首次出现时写入映射。
// 发布前必须另外确认 versions.json 已包含目标插件版本键。
const versions = JSON.parse(readFileSync('versions.json', 'utf8'));
if (!Object.values(versions).includes(minAppVersion)) {
    versions[targetVersion] = minAppVersion;
    writeFileSync('versions.json', JSON.stringify(versions, null, '\t'));
}
