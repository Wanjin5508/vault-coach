import { isGraphBuildJob, type GraphBuildJob } from "../../domain/graph-jobs/graph-build-job";
import { VaultCoachPersistentStore } from "../../persistent-store";

const ACTIVE_GRAPH_JOB_PATH = "jobs/graph-build.json";

export class JsonGraphBuildJobStore {
    constructor(private readonly storage: VaultCoachPersistentStore) {}

    async load(): Promise<GraphBuildJob | null> {
        const value = await this.storage.loadKnowledgeIndexJson<unknown>(ACTIVE_GRAPH_JOB_PATH);
        return isGraphBuildJob(value) ? cloneJob(value) : null;
    }

    async save(job: GraphBuildJob): Promise<void> {
        await this.storage.saveKnowledgeIndexJson(ACTIVE_GRAPH_JOB_PATH, job);
    }

    async clear(): Promise<void> {
        await this.storage.removeKnowledgeIndexPath(ACTIVE_GRAPH_JOB_PATH);
    }
}

function cloneJob(job: GraphBuildJob): GraphBuildJob {
    return {
        ...job,
        affectedFiles: [...job.affectedFiles],
        renames: job.renames.map((rename) => ({ ...rename })),
        checkpoint: { ...job.checkpoint },
    };
}
