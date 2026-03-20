# Vault Coach

> 🌐 Language: English | [中文](./README_CN.md)

An [Obsidian](https://obsidian.md) plugin for intelligent local knowledge base Q&A, powered by Advanced RAG (Retrieval-Augmented Generation) and a locally-running [Ollama](https://ollama.com) service. **Your data never leaves your machine.**

![Obsidian](https://img.shields.io/badge/Obsidian-Plugin-7C3AED?logo=obsidian&logoColor=white)
![Version](https://img.shields.io/badge/version-0.0.2-1E90FF)
![Local RAG](https://img.shields.io/badge/Local-RAG-10b981)
![Ollama](https://img.shields.io/badge/Powered%20by-Ollama-111827)
[![License](https://img.shields.io/badge/License-MIT-84cc16)](./LICENSE)

---

## Table of Contents

- [Features](#features)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Roadmap](#roadmap)
- [Architecture](#architecture)
- [Known Issues](#known-issues)
- [Contributing](#contributing)
- [License](#license)

---

## Features

### ✅ Phase 1 (Current — v0.0.2)

| Feature | Description |
|---------|-------------|
| 🔍 Hybrid Retrieval | TF-IDF keyword search + semantic vector search + RRF fusion |
| ✏️ Query Rewrite | Local LLM auto-rewrites queries to improve retrieval quality |
| 📊 Rerank | Optional external rerank service, falls back to heuristic rerank |
| 🧠 Long-term Memory | Cross-session extraction and injection of user preferences |
| 🔄 Incremental Index Sync | Watches vault file changes and updates the index automatically |
| 🌊 Streaming Output | Pseudo-streaming response rendering with low perceived latency |
| 💾 Conversation Persistence | Chat history saved locally and restored after restart |
| 🔒 100% Local | Powered by Ollama REST API — no data leaves your device |

---

## Quick Start

### Prerequisites

- [Obsidian](https://obsidian.md) v1.5.0+
- [Ollama](https://ollama.com) running locally
- At least one chat model (e.g. `gemma3:4b`) and one embedding model pulled

### Installation (Development Build)

```bash
# 1. Clone into your vault's plugin directory
cd <your-vault>/.obsidian/plugins
git clone https://github.com/Wanjin5508/vault-coach vault-coach

# 2. Install dependencies and build
cd vault-coach
npm install
npm run build

# 3. Enable Vault Coach in Obsidian Settings > Community Plugins
```

### Basic Setup

1. Open **Settings → Vault Coach**
2. Set your Ollama base URL (default: `http://127.0.0.1:11434`)
3. Enter your chat model name (e.g. `gemma3:4b`) and embedding model name
4. Click **Rebuild Index** or wait for auto-sync to complete
5. Click the 💬 ribbon icon to start chatting

---

## Configuration

### General

| Setting | Description |
|---------|-------------|
| Assistant Name | Name shown in the sidebar header |
| Default Greeting | First message shown after conversation reset (Markdown supported) |
| Open on Startup | Auto-open Vault Coach when Obsidian loads |
| Default Retrieval Mode | keyword / vector / hybrid (hybrid recommended) |
| Collapse Sources | Whether to collapse the sources section by default |

### Knowledge Base

| Setting | Default | Description |
|---------|---------|-------------|
| Scope | Whole Vault | Or limit to a specific folder |
| Chunk Size | 600 chars | Maximum characters per chunk |
| Chunk Overlap | 120 chars | Overlap between adjacent chunks |
| Auto Sync | ✅ | Watch file changes and update index automatically |
| Debounce Delay | 15,000 ms | Wait time after last file change before syncing |
| Max Wait Time | 120,000 ms | Force sync after this duration regardless |
| File Threshold | 8 files | Trigger immediate sync when this many files change |

### Advanced RAG

| Setting | Default | Description |
|---------|---------|-------------|
| Query Rewrite | ✅ | LLM rewrites the query before retrieval |
| Vector Retrieval | ✅ | Generate embeddings during index build |
| Rerank | ✅ | Rerank retrieved candidates |
| Keyword top-k | 10 | Keyword retrieval candidate count |
| Vector top-k | 10 | Vector retrieval candidate count |
| Hybrid limit | 12 | Max candidates after fusion |
| Rerank top-k | 8 | Candidates entering rerank stage |
| Context chunks | 8 | Final chunks injected into the prompt |
| Source limit | 5 | Max sources shown per answer |
| Temperature | 0.2 | Generation temperature (keep low for RAG) |

### Local Model

| Setting | Description |
|---------|-------------|
| LLM Base URL | Ollama address, default `http://127.0.0.1:11434` |
| Chat Model | Used for query rewrite and answer generation |
| Embedding Model | Used for vector retrieval; rebuild index after changing |
| Rerank Service URL | Optional; leave empty to use heuristic rerank |
| Rerank Model | Used when a rerank service URL is configured |

### Long-term Memory

| Setting | Default | Description |
|---------|---------|-------------|
| Enable Memory | ✅ | Extract and store useful facts after each turn |
| Memory Top-k | 4 | Max memories injected per answer |
| Max Memory Items | 150 | Oldest/least-accessed items are evicted when exceeded |
| Max Persisted Messages | 60 | Max conversation messages kept in local storage |

---

## Roadmap

See [PROJECT_PLAN.md](./PROJECT_PLAN.md) for the full three-phase development plan.

### Phase Overview

| Phase | Name | Status | Key Goal |
|-------|------|--------|----------|
| Phase 1 | Advanced RAG Q&A | ✅ **Complete** | Hybrid retrieval + Rerank + Long-term memory + Incremental index |
| Phase 2 | Knowledge Graph Enhancement | 🔜 Planned | Entity extraction + Graph construction + Smart query routing |
| Phase 3 | Agentic Interview Assistant | 🔜 Planned | Multi-role agents + Interview simulation + Skill diagnosis |
| Phase 4 | Standalone Application | 🔜 Vision | Independent frontend/backend + Voice + Avatar |

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│                   view.ts (UI)                    │
│         Obsidian ItemView · Right Sidebar         │
└────────────────────┬────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────┐
│                   main.ts                         │
│   Plugin Entry · State Management · Vault Events  │
└──────┬─────────────┬──────────────┬─────────────┘
       │             │              │
┌──────▼──────┐ ┌────▼─────┐ ┌────▼──────────────┐
│  rag-engine │ │knowledge │ │ persistent-store   │
│  Advanced   │ │  -base   │ │ runtime-state.json │
│  RAG Flow   │ │Index/Ret.│ │ index-snapshot.json│
└──────┬──────┘ └──────────┘ └───────────────────┘
       │
┌──────▼──────────────────────────────────────────┐
│                model-client.ts                    │
│     Ollama REST API · /api/chat · /api/embed      │
└─────────────────────────────────────────────────┘
```

For detailed technical documentation, see [TECHNICAL_DOC.docx](./TECHNICAL_DOC.docx).

---

## Known Issues

- **Non-true streaming**: `requestUrl` returns the full response at once; true token-level streaming will require a `fetch` + `ReadableStream` migration
- **Memory search lacks semantic similarity**: Currently uses keyword matching only; embedding-based memory search is planned for Phase 2
- **VIEW_TYPE typo**: The constant value in `constants.ts` says `value-coach-view` instead of `vault-coach-view` (non-breaking, will be fixed in next release)

---

## Contributing

Issues and PRs are welcome! Please check [PROJECT_PLAN.md](./PROJECT_PLAN.md) for the current development direction before opening a PR.

---

## License

[MIT License](./LICENSE)
