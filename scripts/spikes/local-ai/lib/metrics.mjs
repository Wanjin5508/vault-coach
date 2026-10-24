export function rankByCosine(queryVector, corpusRecords) {
    return corpusRecords.map((record) => ({
        chunkId: record.chunkId,
        score: cosine(queryVector, record.vector),
    })).sort((left, right) => right.score - left.score || left.chunkId.localeCompare(right.chunkId));
}

/** 轻量字符/词项基线，专门用于判断内置 embedding 是否优于当前关键词级别。 */
export function rankByKeyword(query, corpus) {
    const queryTokens = tokenize(query);
    return corpus.map((chunk) => {
        const documentTokens = tokenize(chunk.text);
        let intersection = 0;
        for (const token of queryTokens) if (documentTokens.has(token)) intersection += 1;
        const union = new Set([...queryTokens, ...documentTokens]).size;
        return { chunkId: chunk.id, score: union === 0 ? 0 : intersection / union };
    }).sort((left, right) => right.score - left.score || left.chunkId.localeCompare(right.chunkId));
}

export function evaluateRankings(queries, rankings, topKValues) {
    const answerable = queries.filter((query) => query.relevantChunkIds.length > 0);
    const noAnswer = queries.filter((query) => query.relevantChunkIds.length === 0);
    const recall = Object.fromEntries(topKValues.map((topK) => [
        `recallAt${topK}`,
        average(answerable.map((query) => recallAt(rankings.get(query.id) ?? [], query.relevantChunkIds, topK))),
    ]));
    const reciprocalRanks = answerable.map((query) => reciprocalRank(rankings.get(query.id) ?? [], query.relevantChunkIds));
    return {
        queryCount: queries.length,
        answerableQueryCount: answerable.length,
        noAnswerQueryCount: noAnswer.length,
        ...recall,
        mrr: average(reciprocalRanks),
        noAnswerTopScore: summarizeNumbers(noAnswer.map((query) => rankings.get(query.id)?.[0]?.score).filter(Number.isFinite)),
    };
}

export function summarizeNumbers(values) {
    if (values.length === 0) return { count: 0, min: null, max: null, mean: null, p50: null, p95: null };
    const sorted = [...values].sort((left, right) => left - right);
    return {
        count: sorted.length,
        min: sorted[0],
        max: sorted.at(-1),
        mean: average(sorted),
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
    };
}

export function evaluateThresholds(metricsByLanguage, protocol, performance) {
    const failures = [];
    for (const [language, metrics] of Object.entries(metricsByLanguage)) {
        const recallMinimum = protocol.thresholds.recallAt10MinimumByLanguage[language];
        const mrrMinimum = protocol.thresholds.mrrMinimumByLanguage[language];
        if (metrics.recallAt10 < recallMinimum) failures.push(`${language}: Recall@10 ${metrics.recallAt10} < ${recallMinimum}`);
        if (metrics.mrr < mrrMinimum) failures.push(`${language}: MRR ${metrics.mrr} < ${mrrMinimum}`);
    }
    if (performance) {
        if (performance.queryLatencyMs.p95 > protocol.thresholds.queryP95MsDesktopMaximum) {
            failures.push(`query P95 ${performance.queryLatencyMs.p95}ms > ${protocol.thresholds.queryP95MsDesktopMaximum}ms`);
        }
        if (performance.corpusChunksPerSecond < protocol.thresholds.indexChunksPerSecondDesktopMinimum) {
            failures.push(`index throughput ${performance.corpusChunksPerSecond} < ${protocol.thresholds.indexChunksPerSecondDesktopMinimum} chunks/s`);
        }
        if (performance.loadMs > protocol.thresholds.warmLoadMsDesktopMaximum) {
            failures.push(`load ${performance.loadMs}ms > ${protocol.thresholds.warmLoadMsDesktopMaximum}ms`);
        }
        if (performance.rssMb > protocol.thresholds.peakMemoryMbDesktopMaximum) {
            failures.push(`RSS ${performance.rssMb}MB > ${protocol.thresholds.peakMemoryMbDesktopMaximum}MB`);
        }
    }
    return {
        status: protocol.status === "approved" && failures.length === 0 ? "pass" : "pending",
        protocolApproved: protocol.status === "approved",
        failures,
    };
}

function tokenize(text) {
    const normalized = text.toLocaleLowerCase().normalize("NFKC");
    const tokens = new Set(normalized.match(/[\p{L}\p{N}]+/gu) ?? []);
    const cjk = [...normalized].filter((character) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(character));
    for (let index = 0; index < cjk.length; index += 1) {
        tokens.add(cjk[index]);
        if (cjk[index + 1]) tokens.add(`${cjk[index]}${cjk[index + 1]}`);
    }
    return tokens;
}

function cosine(left, right) {
    if (left.length !== right.length) throw new Error(`向量维数不一致：${left.length} != ${right.length}`);
    let dot = 0;
    let leftNorm = 0;
    let rightNorm = 0;
    for (let index = 0; index < left.length; index += 1) {
        const leftValue = left[index];
        const rightValue = right[index];
        dot += leftValue * rightValue;
        leftNorm += leftValue * leftValue;
        rightNorm += rightValue * rightValue;
    }
    return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function recallAt(ranking, relevantChunkIds, topK) {
    const retrieved = new Set(ranking.slice(0, topK).map((item) => item.chunkId));
    return relevantChunkIds.filter((chunkId) => retrieved.has(chunkId)).length / relevantChunkIds.length;
}

function reciprocalRank(ranking, relevantChunkIds) {
    const relevant = new Set(relevantChunkIds);
    const index = ranking.findIndex((item) => relevant.has(item.chunkId));
    return index < 0 ? 0 : 1 / (index + 1);
}

function average(values) {
    return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(sorted, fraction) {
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}
