# Vault Coach

> Language: English | [中文](./README_CN.md)

Vault Coach is an [Obsidian](https://obsidian.md) plugin for asking questions over your Markdown vault with RAG (Retrieval-Augmented Generation). It is local-first with [Ollama](https://ollama.com), and can also use user-configured OpenAI-compatible cloud services for chat and embeddings.

![Obsidian](https://img.shields.io/badge/Obsidian-Plugin-7C3AED?logo=obsidian&logoColor=white)
![Version](https://img.shields.io/badge/version-1.2.2-1E90FF)
![Local RAG](https://img.shields.io/badge/Local-RAG-10b981)
![Ollama](https://img.shields.io/badge/Powered%20by-Ollama-111827)
[![License](https://img.shields.io/badge/License-MIT-84cc16)](./LICENSE)

## What It Does

Vault Coach builds a searchable knowledge base from your Obsidian Markdown files, retrieves relevant notes for each question, and asks a local or configured remote model to answer with cited sources.

Key features:

- Hybrid retrieval: keyword search, vector search, and hybrid fusion.
- Query rewrite: improves retrieval queries before searching the vault.
- Rerank: optional external rerank service, with local heuristic fallback.
- Long-term memory: extracts durable user facts and injects relevant memories into future answers.
- Incremental index sync: watches Markdown changes and updates the index automatically.
- True streaming output: answer text appears as the model generates it, then renders as Markdown after completion.
- Markdown sources: source excerpts render Markdown and link back to vault notes.
- Bilingual UI: plugin view and settings follow the operating system language, currently Chinese or English.
- Local-first privacy model: Ollama is the default; remote services are used only after explicit configuration.

## First Run

After enabling Vault Coach, open the plugin view from the ribbon icon or command palette. Before asking questions, review **Settings → Vault Coach** and confirm the knowledge base and model settings.

Recommended first setup:

1. In **Knowledge base**, choose whether to scan the entire vault or a specific folder.
2. In **Models**, keep **Local Ollama** selected if you want all model calls to stay on your machine.
3. Enter a local chat model and a local embedding model that exist in Ollama.
4. Select **Rebuild index** in the sidebar, or wait for automatic sync after file changes.
5. Ask a question in the Vault Coach sidebar.

The first question can take longer because the plugin may need to build the text index, build or refresh embeddings, retrieve context, and call the model. During answer generation, Vault Coach streams text into the assistant bubble before rendering the final Markdown response.

## Configuration Guide

The settings page is organized in the same order as the plugin UI.

### General

Use this section for sidebar behavior and conversation defaults.

| Setting | What it controls | Guidance |
|---------|------------------|----------|
| Assistant name | The name shown in the sidebar header and assistant message metadata. | Keep the default unless you want a custom assistant identity. |
| Default greeting | The first assistant message after resetting the conversation. Markdown is supported. | If left as the built-in greeting, it follows the OS language. Custom text is preserved. |
| Open right sidebar on startup | Opens Vault Coach automatically when Obsidian starts. | Disable this if you prefer opening the plugin only when needed. |
| Default retrieval mode | The initial retrieval channel: keyword, vector, or hybrid. | Hybrid is recommended for most vaults. |
| Collapse sources by default | Whether answer sources start collapsed. | Enable for a cleaner chat view; disable if you inspect sources often. |

### Knowledge Base

Use this section to decide what Markdown content enters the index and how notes are split into chunks.

| Setting | Default | What it controls | Guidance |
|---------|---------|------------------|----------|
| Scan scope | Entire vault | Whether Vault Coach indexes the whole vault or only one folder. | Use a specific folder for focused projects or private areas you do not want indexed. |
| Specific folder | Empty | Folder path used when scan scope is set to a specific folder. | Use a vault-relative path, for example `Knowledge/RAG`. |
| Chunk size | 600 | Maximum characters per chunk. | Larger chunks preserve context but increase embedding and prompt cost. |
| Chunk overlap | 120 | Characters shared between adjacent chunks. | Keep some overlap to reduce boundary loss between chunks. |
| Enable automatic incremental sync | On | Watches Markdown changes and syncs the index automatically. | Keep enabled for normal use. |
| Auto-sync file threshold | 8 | Triggers sync immediately after enough files change. | Lower values update sooner; higher values reduce background work. |
| Auto-sync debounce time | 15,000 ms | Wait time after the last file change before syncing. | Increase if you often edit many files in bursts. |
| Auto-sync maximum wait | 120,000 ms | Forces sync after this time even if changes continue. | Prevents long editing sessions from delaying sync indefinitely. |

Changing scan scope, chunk size, chunk overlap, or embedding settings marks the knowledge base dirty. Rebuild the index before expecting updated retrieval results.

### Models

This section chooses the actual services used for answer generation, embeddings, and optional rerank. Only the currently selected services are called.

#### Answer Model Service

The answer model is used for query rewrite, final answer generation, and long-term memory extraction.

| Option | What it means | Required fields |
|--------|---------------|-----------------|
| Local Ollama | Calls the local Ollama chat API. | Local inference service URL, local chat model. |
| OpenAI compatible | Calls a configured remote or self-hosted OpenAI-compatible chat API. | Cloud chat service URL, cloud chat model, cloud API key. |

For Ollama, the base URL should normally be `http://127.0.0.1:11434`. Do not include `/api/chat` in the base URL.

For OpenAI-compatible services, use the provider's base URL or `/v1` URL. Vault Coach builds the `/chat/completions` path automatically when needed.

#### Embedding Model Service

The embedding model is used for vector retrieval. Changing it requires rebuilding the index because existing vectors no longer match the new model.

| Option | What it means | Required fields |
|--------|---------------|-----------------|
| Local Ollama | Calls Ollama embedding APIs locally. | Local inference service URL, local embedding model. |
| OpenAI compatible | Calls a configured remote or self-hosted embedding API. | Cloud embedding service URL, cloud embedding model, cloud API key. |

Remote embeddings may send many vault chunks to the configured provider during index building. Use remote embeddings only when you understand and accept that data flow.

#### Cloud API Key

Vault Coach stores only the SecretStorage entry name in plugin settings. The raw API key should be stored through Obsidian SecretStorage, not in `data.json`.

#### Optional Rerank Service

Rerank is optional. If **Dedicated rerank service URL** or **Rerank model** is empty, Vault Coach falls back to local heuristic rerank.

| Setting | What it controls |
|---------|------------------|
| Dedicated rerank service URL | Optional rerank endpoint, commonly a `/v1/rerank` compatible service. |
| Rerank model | Model name used by that rerank endpoint. |

### Long-Term Memory

Long-term memory stores useful facts extracted from previous conversations and injects relevant entries into later answers.

| Setting | Default | What it controls | Guidance |
|---------|---------|------------------|----------|
| Enable long-term memory | On | Whether Vault Coach extracts and uses durable memories. | Disable if you want each session to behave independently. |
| Memory injection count | 4 | Maximum memories injected into one answer. | Keep low to avoid distracting the model. |
| Maximum memory items | 150 | Total memory entries retained locally. | Increase only if you rely heavily on cross-session context. |
| Maximum persisted messages | 60 | Conversation messages saved locally. | Higher values preserve more context but grow runtime state. |

### Advanced RAG

These settings control retrieval quality and prompt construction. The defaults are intended to be conservative.

| Setting | Default | What it controls | Guidance |
|---------|---------|------------------|----------|
| Enable query rewrite | On | Rewrites questions into retrieval-friendly queries. | Keep enabled unless rewrite quality is poor for your notes. |
| Enable vector retrieval | On | Builds embeddings and enables vector or hybrid search. | Disable only if you want keyword-only retrieval or cannot use embeddings. |
| Enable rerank | On | Reranks recalled candidates before prompt construction. | Keep enabled for better source ordering. |
| Keyword top k | 10 | Number of keyword candidates. | Increase for broad queries. |
| Vector top k | 10 | Number of vector candidates. | Increase for semantic recall at the cost of more rerank work. |
| Hybrid candidate limit | 12 | Candidates kept after keyword/vector fusion. | Keep near the default unless retrieval misses useful notes. |
| Rerank top k | 8 | Candidates entering rerank. | More candidates can improve recall but increase work. |
| Context chunks | 8 | Chunks injected into the final prompt. | More is not always better; too much context can dilute the answer. |
| Source limit | 5 | Sources shown below each answer. | Increase if you want broader citations. |
| Generation temperature | 0.2 | Model randomness during answer generation. | Low values are better for grounded knowledge-base answers. |

## Sidebar Controls

The sidebar header shows current index status, file and chunk counts, vector status, and memory count in a compact grid.

- **Q&A / Exam mode**: a front-end mode switch. Q&A mode is the active behavior today; exam-mode backend behavior is not implemented yet.
- **Retrieval mode**: switches the current session between keyword, vector, and hybrid retrieval.
- **Rebuild index**: rebuilds the text index and, if enabled, the vector index.
- **Reset conversation**: clears the chat history and returns to the default greeting.

## Privacy and Network Use

Vault Coach is local-first. With the default Ollama settings, chat and embedding requests are sent to the configured local Ollama endpoint, usually `http://127.0.0.1:11434`.

Remote calls happen only when you explicitly choose an OpenAI-compatible answer or embedding provider and configure the corresponding endpoint, model, and API key.

When a remote answer model is enabled, the configured service may receive:

- The current user question.
- Retrieved Markdown chunks used as RAG context.
- A small amount of recent conversation context.
- Relevant long-term memory entries if memory is enabled.
- Model parameters such as model name and temperature.

When a remote embedding provider is enabled, the configured service may receive Markdown chunks while building or refreshing the vector index.

Vault Coach does not include hidden telemetry. The plugin cannot control how a selected provider stores or processes submitted data, so review the provider's privacy and retention policy before enabling remote services.

## Notes and Current Limits

- Streaming text is displayed as plain text while tokens arrive. After generation finishes, the complete answer is rendered as Markdown.
- Source excerpts are Markdown-rendered, but Mermaid fences inside truncated excerpts are rendered as text to avoid Obsidian Mermaid errors.
- Long-term memory search is keyword-based at the moment.
- Exam mode is currently a UI switch only; Q&A mode remains the implemented behavior.

## Roadmap

See [PROJECT_PLAN.md](./PROJECT_PLAN.md) for the broader development direction.

## Contributing

Issues and PRs are welcome. For bugs, include reproduction steps, the model provider in use, relevant settings, and any console errors.

## License

[MIT License](./LICENSE)
