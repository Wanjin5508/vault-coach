/**
 * 识别 AbortError，避免把用户主动取消记录为普通失败。
 */
export function isAbortError(error: unknown): boolean {
    if (error instanceof DOMException) {
        return error.name === "AbortError";
    }

    if (error instanceof Error) {
        return error.name === "AbortError" || /aborted|aborterror/i.test(error.message);
    }

    return false;
}

export function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
