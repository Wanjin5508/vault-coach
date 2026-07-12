export type QuestionLanguage = "zh" | "en";

const HAN_CHARACTER_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const HAN_CHARACTER_GLOBAL_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
const LATIN_WORD_PATTERN = /[A-Za-z][A-Za-z'-]*/g;
const ENGLISH_QUESTION_SIGNAL_PATTERN = /\b(?:what|why|how|when|where|which|who|whom|whose|is|are|am|was|were|do|does|did|can|could|should|would|will|explain|describe|compare|summarize|define|tell)\b/i;
const CHINESE_QUESTION_SIGNAL_PATTERN = /(?:什么|如何|怎么|为什么|请问|请|解释|说明|总结|对比|比较|是否|能否|吗|呢|的|是|在|和|与|用|将|把|对|中|为)/;

export function detectQuestionLanguage(question: string): QuestionLanguage {
    const trimmedQuestion: string = question.trim();
    const hanCount: number = countMatches(trimmedQuestion, HAN_CHARACTER_GLOBAL_PATTERN);
    if (hanCount === 0 || !HAN_CHARACTER_PATTERN.test(trimmedQuestion)) {
        return "en";
    }

    const latinWordCount: number = countMatches(trimmedQuestion, LATIN_WORD_PATTERN);
    if (latinWordCount === 0) {
        return "zh";
    }

    const hasEnglishSignal: boolean = ENGLISH_QUESTION_SIGNAL_PATTERN.test(trimmedQuestion);
    const hasChineseSignal: boolean = CHINESE_QUESTION_SIGNAL_PATTERN.test(trimmedQuestion);

    if (hasEnglishSignal && !hasChineseSignal) {
        return "en";
    }

    if (hasChineseSignal && !hasEnglishSignal) {
        return "zh";
    }

    if (hasChineseSignal && hanCount >= 2) {
        return "zh";
    }

    return latinWordCount >= hanCount ? "en" : "zh";
}

function countMatches(text: string, pattern: RegExp): number {
    return text.match(pattern)?.length ?? 0;
}
