/**
 * 全局常量模块。
 *
 * 集中维护插件视图标识、默认配置值和本地持久化路径，避免业务模块散落硬编码。
 * 这些值会被设置页、主插件生命周期、索引持久化和考试模式共同引用。
 */


// 自定义视图的唯一类型 ID；Obsidian 通过它创建和恢复右侧边栏视图。
export const VIEW_TYPE_VAULT_COACH = "value-coach-view";


// 显示给用户看的视图名称，通常出现在标签页标题和视图列表中。
export const VIEW_NAME_VAULT_COACH = "ValueCoach";

// ---------------------------
// 文本索引和关键词检索默认值
// ---------------------------
export const DEFAULT_CHUNK_SIZE = 600;
export const DEFAULT_CHUNK_OVERLAP = 120;
export const DEFAULT_KEYWORD_TOP_K = 10;
export const DEFAULT_SOURCE_LIMIT = 5;
export const DEFAULT_ENABLE_MARKDOWN_INDEXING = true;
export const DEFAULT_ENABLE_PDF_INDEXING = false;
export const DEFAULT_MAX_PDF_FILE_SIZE_MB = 50;
export const DEFAULT_MAX_PDF_PAGE_COUNT = 300;

// 向量召回时默认保留的候选数。
export const DEFAULT_VECTOR_TOP_K = 10;

// 混合检索合并后的候选上限。
export const DEFAULT_HYBRID_TOP_K = 12;

// 重排时默认处理的候选数量。
export const DEFAULT_RERANK_TOP_K = 8;

// 最终注入到提示词中的上下文 chunk 数量。
export const DEFAULT_CONTEXT_TOP_K = 8;

// 生成回答时的默认温度。
export const DEFAULT_GENERATION_TEMPERATURE = 0.2;

// 与 Ollama 本地服务对接时常见的默认地址。
export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";

// 默认模型提供方。默认使用本地 Ollama，用户可在设置页切换为 OpenAI-compatible 服务。
export const DEFAULT_MODEL_PROVIDER = "ollama";
export const DEFAULT_EMBEDDING_PROVIDER = "ollama";
export const DEFAULT_CLOUD_BASE_URL = "https://api.deepseek.com/"
export const DEFAULT_CLOUD_CHAT_MODEL = "deepseek-v4-flash";
export const DEFAULT_CLOUD_EMBEDDING_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_CLOUD_EMBEDDING_MODEL = "text-embedding-3-small";

// 默认模型名只作为“示例默认值”，用户可以在设置中自行改成自己的本地模型。
export const DEFAULT_CHAT_MODEL = "gemma3:4b";
export const DEFAULT_EMBEDDING_MODEL = "embeddinggemma";

// RRF（Reciprocal Rank Fusion）中的常用平滑常量。
export const DEFAULT_RRF_K = 60;

/**
 * 长期记忆与会话持久化默认值
 */
export const DEFAULT_ENABLE_LONG_TERM_MEMORY = true;
export const DEFAULT_MEMORY_TOP_K = 4;
export const DEFAULT_MEMORY_MAX_ITEMS = 150;
export const DEFAULT_MAX_CONVERSATION_MESSAGES = 60;

// 自动增量索引默认值。
export const DEFAULT_ENABLE_AUTO_INDEX_SYNC = true;
export const DEFAULT_AUTO_INDEX_DEBOUNCE_MS = 15000;
export const DEFAULT_AUTO_INDEX_MAX_WAIT_MS = 120000;
export const DEFAULT_AUTO_INDEX_FILE_THRESHOLD = 8;

// 插件根目录下的本地持久化文件名。
export const RUNTIME_STATE_FILE_NAME = "runtime-state.json"
export const INDEX_SNAPSHOT_FILE_NAME = "index-snapshot.json"
export const EXAM_CONTENT_PROFILE_CACHE_FILE_NAME = "exam-content-profiles.json"

// 考试结果保存到 vault 内的隐藏目录，避免干扰用户正常笔记列表。
export const VAULT_COACH_HIDDEN_DIR_PATH = ".vault-coach";
export const EXAM_RESULTS_DIR_PATH = `${VAULT_COACH_HIDDEN_DIR_PATH}/exams`;
export const EXAM_CONTENT_PROFILE_CACHE_PATH = `${VAULT_COACH_HIDDEN_DIR_PATH}/${EXAM_CONTENT_PROFILE_CACHE_FILE_NAME}`;
export const ASSESSMENTS_DIR_PATH = `${VAULT_COACH_HIDDEN_DIR_PATH}/assessments`;
export const ASSESSMENT_SESSIONS_DIR_PATH = `${ASSESSMENTS_DIR_PATH}/sessions`;
export const ASSESSMENT_INDEX_PATH = `${ASSESSMENTS_DIR_PATH}/index-v1.json`;
