// 用于存放项目中的常量，避免字符串硬编码


// 自定义视图的唯一类型 ID，这个值不能和已有的视图类型 ID 重复
export const VIEW_TYPE_VAULT_COACH = "value-coach-view";


// 显示给用户看的视图名称
export const VIEW_NAME_VAULT_COACH = "ValueCoach";

// ---------------------------
// 第一阶段沿用的默认值
// ---------------------------
export const DEFAULT_CHUNK_SIZE = 600;
export const DEFAULT_CHUNK_OVERLAP = 120;
export const DEFAULT_KEYWORD_TOP_K = 10;
export const DEFAULT_SOURCE_LIMIT = 5;

// ---------------------------
// 第二阶段新增的默认值
// ---------------------------
// 向量召回时默认取多少个候选。
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

// 本地持久化文件名
export const RUNTIME_STATE_FILE_NAME = "runtime-state.json"
export const INDEX_SNAPSHOT_FILE_NAME = "index-snapshot.json"



