import type { VectorBuildJob } from "../../domain/index-jobs/vector-build-job";
import { isVectorBuildJob } from "../../domain/index-jobs/vector-build-job";
import { VaultCoachPersistentStore } from "../../persistent-store";

const ACTIVE_VECTOR_JOB_PATH = "jobs/vector-build.json";

export class JsonVectorBuildJobStore {
    constructor(private readonly storage: VaultCoachPersistentStore) {}

    async load(): Promise<VectorBuildJob | null> {
        const value = await this.storage.loadKnowledgeIndexJson<unknown>(ACTIVE_VECTOR_JOB_PATH);
        return isVectorBuildJob(value) ? cloneJob(value) : null;
    }

    async save(job: VectorBuildJob): Promise<void> {
        await this.storage.saveKnowledgeIndexJson(ACTIVE_VECTOR_JOB_PATH, job);
    }

    async clear(): Promise<void> {
        await this.storage.removeKnowledgeIndexPath(ACTIVE_VECTOR_JOB_PATH);
    }
}

function cloneJob(job: VectorBuildJob): VectorBuildJob { return { ...job }; }
