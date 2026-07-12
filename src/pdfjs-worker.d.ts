declare module "pdfjs-dist/build/pdf.worker.mjs" {
    export const WorkerMessageHandler: {
        initializeFromPort(port: {
            postMessage(message: unknown, transfer?: Transferable[]): void;
            addEventListener(name: "message", listener: (event: MessageEvent<unknown>) => void): void;
            removeEventListener(name: "message", listener: (event: MessageEvent<unknown>) => void): void;
        }): void;
    };
}
