import { describe, expect, it } from "vitest";
import {
    createInitialSetupState,
    parseSetupState,
} from "../../../src/app/setup/setup-state";

describe("setup state", () => {
    it("auto-enrolls only genuinely new installations", () => {
        expect(createInitialSetupState("new-install")).toMatchObject({
            disposition: "pending",
            entryReason: "new-install",
            lastStep: "scope",
        });
        expect(createInitialSetupState("legacy")).toMatchObject({
            disposition: "grandfathered",
            entryReason: "upgrade",
            lastStep: "complete",
        });
        expect(createInitialSetupState("current")).toMatchObject({
            disposition: "grandfathered",
            entryReason: "upgrade",
            lastStep: "complete",
        });
    });

    it("rejects future, malformed, or negative-timestamp setup facts", () => {
        expect(parseSetupState({ schemaVersion: 2 })).toBeNull();
        expect(parseSetupState({
            schemaVersion: 1,
            disposition: "pending",
            entryReason: "new-install",
            lastStep: "scope",
            updatedAt: -1,
        })).toBeNull();
    });
});
