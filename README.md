<p align="right">
  English | <a href="README.zh.md">中文</a>
</p>

# Vault Coach

A local RAG-style Obsidian plugin for vault knowledge retrieval, question answering, and interview practice, powered by Ollama.

---

### Overview

**Vault Coach** is a local-first Obsidian plugin designed for knowledge retrieval and interactive Q&A inside your vault.

It starts from a lightweight non-LLM retrieval backbone and gradually evolves into an advanced local RAG pipeline with:

- query rewrite
- vector retrieval
- hybrid retrieval
- reranking
- prompt/context optimization

The long-term goal is to turn your vault into a **local knowledge assistant and interview practice environment** without relying on external cloud services.

---

### Current Status

The project is currently planned and documented in **4 stages**.

**Implemented up to Stage 2:**
- non-LLM retrieval backbone
- advanced local RAG pipeline
- markdown-formatted assistant responses

**Planned next:**
- graph-enhanced retrieval
- lightweight knowledge graph exploration
- optional ontology layer for domain vaults
- interview mode orchestration

---

### Key Features

#### Implemented Features (up to Stage 2)

- **Extended settings panel**
  - configure plugin behavior and local model-related options
  - define retrieval scope and response preferences

- **Right sidebar chat view**
  - interactive assistant panel inside Obsidian
  - supports local Q&A workflow in the vault

- **Vault / folder scope scanning**
  - scan notes from the whole vault or selected folders
  - limit retrieval to user-defined ranges

- **Markdown chunking**
  - split notes into retrieval-friendly chunks
  - preserve source-note relationships for traceability

- **Keyword retrieval**
  - lightweight lexical retrieval without vector dependency
  - provides a usable local knowledge Q&A baseline

- **Source folding and jump-to-note**
  - show answer sources in collapsible form
  - jump back to the original note / section

- **Query rewrite**
  - optimize the user query before retrieval
  - improve recall for shorthand, vague, or noisy questions

- **Embedding / vector retrieval**
  - use embeddings for semantic search
  - retrieve relevant chunks beyond literal keyword overlap

- **Hybrid merge**
  - combine keyword retrieval and vector retrieval results
  - balance precision and semantic recall

- **Rerank**
  - rerank retrieved candidates before generation
  - improve final context quality for the LLM

- **Prompt and context construction optimization**
  - assemble cleaner, better-structured context
  - reduce noise and improve answer grounding

- **Markdown-formatted assistant output**
  - render answers as Markdown instead of plain text
  - better readability for lists, code blocks, headings, and references

---

### Retrieval Pipeline

Current pipeline (up to Stage 2):

`User Query`
→ `Query Rewrite`
→ `Keyword Retrieval + Vector Retrieval`
→ `Hybrid Merge`
→ `Rerank`
→ `Prompt / Context Builder`
→ `Local LLM Generation`
→ `Markdown Answer + Source Display`

This design keeps the system modular and allows each retrieval component to evolve independently.

---

### Project Structure

```text
src/
  main.ts
  settings.ts
  view.ts
  types.ts
  constants.ts
styles.css
```

---

### Development Roadmap

## Stage 1: Build the non-LLM backbone first

* [x] Extend settings
* [x] Implement right sidebar view
* [x] Implement vault/folder scope scanning
* [x] Implement markdown chunking
* [x] Implement keyword retrieval
* [x] Implement source folding and jump

At this point, the plugin already becomes a **working local knowledge Q&A plugin without vector search**.

---

## Stage 2: Add Advanced RAG

* [x] Add query rewrite
* [x] Add embedding / vector retrieval
* [x] Add hybrid merge
* [x] Add rerank
* [x] Optimize prompt and context construction
* [x] Improve assistant output rendering with Markdown

This stage upgrades the plugin from a lexical retriever into a more complete **local advanced RAG assistant**.

---

## Stage 3: Explore more fine-grained retrieval modes

### Layer 1: Weak graph enhancement

Leverage the existing vault structure directly:

* note ↔ wikilink note
* note ↔ heading
* note ↔ tag
* note ↔ folder / topic
* chunk ↔ source note

Then apply **graph-aware expansion / rerank** after retrieval.

This layer has the highest cost-performance ratio.

### Layer 2: Lightweight knowledge graph

Extract chunk-level signals such as:

* entities
* synonyms
* co-occurrence relations
* citation / reference relations
* topic communities

Then use them for:

* query expansion
* neighborhood expansion recall
* multi-hop candidate completion
* path-based explanation

At this stage, a strict ontology is still unnecessary.

### Layer 3: Optional ontology overlay

Enable only for specialized vaults, such as:

* high-voltage test equipment manuals
* technical specifications
* experimental procedures
* regulations / contracts
* medical knowledge bases

Then define:

* concept hierarchies
* relation schema
* synonym normalization
* alias mapping
* rule-based reasoning

---

## Stage 4: Interview Mode

* [ ] Question generation
* [ ] Conversation state machine
* [ ] User answer evaluation
* [ ] Next question / finish interview / review summary

**Why this comes last:**
Interview mode is not infrastructure.
It is a higher-level orchestration layer built on top of retrieval, ranking, grounding, and generation.

---

### Long-Term Vision

Vault Coach is intended to evolve from:

**local note retrieval tool**
→ **advanced local RAG assistant**
→ **graph-enhanced knowledge navigator**
→ **interactive interview and study coach**

---

### Tech Direction

* **Local-first**
* **Obsidian-native workflow**
* **Ollama-powered generation**
* **Modular retrieval architecture**
* **Extensible toward graph and ontology reasoning**
