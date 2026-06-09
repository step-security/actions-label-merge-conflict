import * as core from "@actions/core";
import * as github from "@actions/github";
import {
	deriveBaseRef,
	processPullRequests,
	validateSubscription,
	type LabelerConfig,
} from "./labeler";

async function main(): Promise<void> {
	await validateSubscription();

	const token = core.getInput("repoToken", { required: true });
	const conflictLabel = core.getInput("dirtyLabel", { required: true });
	const ignorePermissionErrors =
		core.getInput("continueOnMissingPermissions") === "true";
	const maxRetries = Number.parseInt(core.getInput("retryMax") || "5", 10);
	const labelToRemove = core.getInput("removeOnDirtyLabel");
	const retryDelayMs =
		Number.parseInt(core.getInput("retryAfter") || "120", 10) * 1000;
	const cleanComment = core.getInput("commentOnClean");
	const dirtyComment = core.getInput("commentOnDirty");

	const octokit = github.getOctokit(token);
	const { owner, repo } = github.context.repo;
	const baseRef = deriveBaseRef();

	const config: LabelerConfig = {
		octokit,
		owner,
		repo,
		baseRef,
		dirtyLabel: conflictLabel,
		removeOnDirtyLabel: labelToRemove,
		commentOnDirty: dirtyComment,
		commentOnClean: cleanComment,
		retryAfterMs: retryDelayMs,
		retryBudget: maxRetries,
		continueOnMissingPermissions: ignorePermissionErrors,
	};

	const statuses = await processPullRequests(config);

	core.setOutput("prDirtyStatuses", statuses);
}

main().catch((error) => {
	const message = error instanceof Error ? error.message : String(error);
	core.error(message);
	core.setFailed(message);
});
