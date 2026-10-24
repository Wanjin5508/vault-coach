# Third-party notices

Vault Coach bundles or uses the following components for its built-in embedding runtime:

| Component | Version / revision | License | Purpose |
| --- | --- | --- | --- |
| [Transformers.js](https://github.com/huggingface/transformers.js) | 4.3.1 | Apache-2.0 | Tokenization, model loading, and feature extraction |
| [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) | 1.31.0 development dependency resolved by Transformers.js | MIT | Local WebAssembly inference |
| [Xenova/multilingual-e5-small](https://huggingface.co/Xenova/multilingual-e5-small) | `761b726dd34fb83930e26aab4e9ac3899aa1fa78` | MIT upstream model | Quantized multilingual embedding model |

Model weights are not included in the plugin release. Vault Coach downloads the pinned model assets only after an explicit user action. The original licenses and notices of these projects continue to apply.
