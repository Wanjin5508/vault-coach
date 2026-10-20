import { VAULT_COACH_HIDDEN_DIR_PATH } from "../../constants";

/**
 * 规范化 Vault 内部相对路径。
 *
 * Vault 路径始终使用正斜杠。本函数不调用 Node.js path API，因此可以在桌面端和移动端共用。
 */
export function normalizeVaultPath(path: string): string {
    return path
        .trim()
        .replace(/\\/g, "/")
        .replace(/\/+/g, "/")
        .replace(/^\/+|\/+$/g, "");
}

/** 返回规范化 Vault 相对路径的目录深度；Vault 根目录深度为 0。 */
export function getVaultFolderDepth(path: string): number {
    const normalizedPath = normalizeVaultPath(path);
    return normalizedPath.length === 0 ? 0 : normalizedPath.split("/").length;
}

/** 判断路径是否位于 Vault Coach 自己的隐藏数据目录中。 */
export function isVaultCoachHiddenPath(path: string): boolean {
    const normalizedPath = normalizeVaultPath(path);
    return normalizedPath === VAULT_COACH_HIDDEN_DIR_PATH
        || normalizedPath.startsWith(`${VAULT_COACH_HIDDEN_DIR_PATH}/`);
}

/** 返回文件路径的全部非内部父目录，顺序从第一层到最深一层。 */
export function getParentFolderPaths(filePath: string): string[] {
    const pathParts = normalizeVaultPath(filePath).split("/");
    pathParts.pop();

    const folderPaths: string[] = [];
    for (let length = 1; length <= pathParts.length; length += 1) {
        const folderPath = pathParts.slice(0, length).join("/");
        if (folderPath.length > 0 && !isVaultCoachHiddenPath(folderPath)) {
            folderPaths.push(folderPath);
        }
    }
    return folderPaths;
}

/** 判断文件是否位于指定 Vault 相对目录内；空目录表示整个 Vault。 */
export function isFileInFolder(filePath: string, folderPath: string): boolean {
    const normalizedFolderPath = normalizeVaultPath(folderPath);
    if (normalizedFolderPath.length === 0) return true;
    return normalizeVaultPath(filePath).startsWith(`${normalizedFolderPath}/`);
}
