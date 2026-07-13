/**
 * PDF.js worker 模块类型声明。
 *
 * pdfjs-dist 的 worker 入口在当前打包环境下没有完整类型暴露，
 * 这里仅声明插件实际使用的消息端口初始化接口。
 */
declare module "pdfjs-dist/build/pdf.worker.mjs" {
    export const WorkerMessageHandler: {
        initializeFromPort(port: {
            postMessage(message: unknown, transfer?: Transferable[]): void;
            addEventListener(name: "message", listener: (event: MessageEvent<unknown>) => void): void;
            removeEventListener(name: "message", listener: (event: MessageEvent<unknown>) => void): void;
        }): void;
    };
}
