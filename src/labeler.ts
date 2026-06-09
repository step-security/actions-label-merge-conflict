import fs from "fs";
import * as core from "@actions/core";
import * as github from "@actions/github";
import axios, { isAxiosError } from "axios";

type Octokit = ReturnType<typeof github.getOctokit>;

export type MergeStatus = "CONFLICTING" | "MERGEABLE" | "UNKNOWN";

export interface OpenPullRequest {
	number: number;
	title: string;
	mergeable: MergeStatus;
	labels: string[];
}

export interface PullRequestPage {
	pullRequests: OpenPullRequest[];
	nextCursor: string | null;
}

export interface LabelerConfig {
	octokit: Octokit;
	owner: string;
	repo: string;
	baseRef: string | null;
	dirtyLabel: string;
	removeOnDirtyLabel: string;
	commentOnDirty: string;
	commentOnClean: string;
	retryAfterMs: number;
	retryBudget: number;
	continueOnMissingPermissions: boolean;
}

const LIST_QUERY = `
query ListOpenPullRequests($owner: String!, $repo: String!, $baseRefName: String, $after: String) {
	repository(owner: $owner, name: $repo) {
		pullRequests(first: 100, states: OPEN, baseRefName: $baseRefName, after: $after) {
			nodes {
				number
				title
				mergeable
				labels(first: 100) {
					nodes { name }
				}
			}
			pageInfo {
				endCursor
				hasNextPage
			}
		}
	}
}
`;

export async function validateSubscription(): Promise<void> {
	const eventPath = process.env.GITHUB_EVENT_PATH;
	let repoPrivate: boolean | undefined;

	if (eventPath && fs.existsSync(eventPath)) {
		const eventData = JSON.parse(fs.readFileSync(eventPath, "utf8"));
		repoPrivate = eventData?.repository?.private;
	}

	const upstream = "eps1lon/actions-label-merge-conflict";
	const action = process.env.GITHUB_ACTION_REPOSITORY;
	const docsUrl =
		"https://docs.stepsecurity.io/actions/stepsecurity-maintained-actions";

	core.info("");
	core.info("\u001b[1;36mStepSecurity Maintained Action\u001b[0m");
	core.info(`Secure drop-in replacement for ${upstream}`);
	if (repoPrivate === false)
		core.info("\u001b[32m✓ Free for public repositories\u001b[0m");
	core.info(`\u001b[36mLearn more:\u001b[0m ${docsUrl}`);
	core.info("");

	if (repoPrivate === false) return;

	const serverUrl = process.env.GITHUB_SERVER_URL || "https://github.com";
	const body: Record<string, string> = { action: action || "" };
	if (serverUrl !== "https://github.com") body.ghes_server = serverUrl;

	try {
		await axios.post(
			`https://agent.api.stepsecurity.io/v1/github/${process.env.GITHUB_REPOSITORY}/actions/maintained-actions-subscription`,
			body,
			{ timeout: 3000 },
		);
	} catch (error) {
		if (isAxiosError(error) && error.response?.status === 403) {
			core.error(
				`\u001b[1;31mThis action requires a StepSecurity subscription for private repositories.\u001b[0m`,
			);
			core.error(
				`\u001b[31mLearn how to enable a subscription: ${docsUrl}\u001b[0m`,
			);
			process.exit(1);
		}
		core.info("Timeout or API not reachable. Continuing to next step.");
	}
}

export function deriveBaseRef(): string | null {
	if (process.env.GITHUB_EVENT_NAME !== "push") return null;
	const ref = github.context.ref || "";
	const prefix = "refs/heads/";
	return ref.startsWith(prefix) ? ref.slice(prefix.length) : null;
}

function isMissingPermissionError(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const e = error as { status?: number; message?: string };
	const looksForbiddenOrNotFound = e.status === 403 || e.status === 404;
	const knownMessage =
		typeof e.message === "string" &&
		e.message.includes("Resource not accessible by integration");
	return looksForbiddenOrNotFound && knownMessage;
}

async function fetchPullRequestPage(
	octokit: Octokit,
	owner: string,
	repo: string,
	baseRef: string | null,
	cursor: string | null,
): Promise<PullRequestPage> {
	const response = await octokit.graphql<{
		repository: {
			pullRequests: {
				nodes: Array<{
					number: number;
					title: string;
					mergeable: MergeStatus;
					labels: { nodes: Array<{ name: string }> };
				}>;
				pageInfo: { endCursor: string | null; hasNextPage: boolean };
			};
		};
	}>(LIST_QUERY, {
		owner,
		repo,
		baseRefName: baseRef,
		after: cursor,
	});

	const { nodes, pageInfo } = response.repository.pullRequests;
	const pullRequests: OpenPullRequest[] = nodes.map((node) => ({
		number: node.number,
		title: node.title,
		mergeable: node.mergeable,
		labels: node.labels.nodes.map((l) => l.name),
	}));

	return {
		pullRequests,
		nextCursor: pageInfo.hasNextPage ? pageInfo.endCursor : null,
	};
}

async function applyLabel(
	config: LabelerConfig,
	pull: OpenPullRequest,
	label: string,
): Promise<boolean> {
	if (pull.labels.includes(label)) {
		core.info(`PR #${pull.number} already has "${label}"`);
		return false;
	}

	try {
		await config.octokit.rest.issues.addLabels({
			owner: config.owner,
			repo: config.repo,
			issue_number: pull.number,
			labels: [label],
		});
		return true;
	} catch (error) {
		if (
			config.continueOnMissingPermissions &&
			isMissingPermissionError(error)
		) {
			core.warning(
				`Could not add label "${label}" to PR #${pull.number}: missing permission.`,
			);
			return false;
		}
		throw new Error(
			`Failed to add label "${label}" to PR #${pull.number}: ${error}`,
		);
	}
}

async function clearLabel(
	config: LabelerConfig,
	pull: OpenPullRequest,
	label: string,
): Promise<boolean> {
	if (!pull.labels.includes(label)) {
		core.info(`PR #${pull.number} does not have "${label}"`);
		return false;
	}

	try {
		await config.octokit.rest.issues.removeLabel({
			owner: config.owner,
			repo: config.repo,
			issue_number: pull.number,
			name: label,
		});
		return true;
	} catch (error) {
		const status = (error as { status?: number }).status;
		if (status === 404) {
			core.info(`Label "${label}" was already absent from PR #${pull.number}.`);
			return false;
		}
		if (
			config.continueOnMissingPermissions &&
			isMissingPermissionError(error)
		) {
			core.warning(
				`Could not remove label "${label}" from PR #${pull.number}: missing permission.`,
			);
			return false;
		}
		throw new Error(
			`Failed to remove label "${label}" from PR #${pull.number}: ${error}`,
		);
	}
}

async function writeComment(
	config: LabelerConfig,
	pull: OpenPullRequest,
	body: string,
): Promise<void> {
	try {
		await config.octokit.rest.issues.createComment({
			owner: config.owner,
			repo: config.repo,
			issue_number: pull.number,
			body,
		});
	} catch (error) {
		if (
			config.continueOnMissingPermissions &&
			isMissingPermissionError(error)
		) {
			core.warning(
				`Could not post comment on PR #${pull.number}: missing permission.`,
			);
			return;
		}
		throw new Error(`Failed to post comment on PR #${pull.number}: ${error}`);
	}
}

async function reconcilePullRequest(
	config: LabelerConfig,
	pull: OpenPullRequest,
): Promise<boolean> {
	if (pull.mergeable === "CONFLICTING") {
		core.info(
			`PR #${pull.number} "${pull.title}": conflicting — applying "${config.dirtyLabel}"`,
		);
		const tasks: Promise<unknown>[] = [
			applyLabel(config, pull, config.dirtyLabel),
		];
		if (config.removeOnDirtyLabel) {
			tasks.push(clearLabel(config, pull, config.removeOnDirtyLabel));
		}
		const [labelAdded] = (await Promise.all(tasks)) as [boolean, ...unknown[]];

		if (labelAdded && config.commentOnDirty) {
			await writeComment(config, pull, config.commentOnDirty);
		}
		return true;
	}

	if (pull.mergeable === "MERGEABLE") {
		core.info(
			`PR #${pull.number} "${pull.title}": mergeable — removing "${config.dirtyLabel}"`,
		);
		const labelRemoved = await clearLabel(config, pull, config.dirtyLabel);
		if (labelRemoved && config.commentOnClean) {
			await writeComment(config, pull, config.commentOnClean);
		}
		return false;
	}

	throw new Error(
		`Unhandled mergeable state for PR #${pull.number}: ${pull.mergeable}`,
	);
}

async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

export async function processPullRequests(
	config: LabelerConfig,
): Promise<Record<number, boolean>> {
	const statuses: Record<number, boolean> = {};
	let cursor: string | null = null;
	let budget = config.retryBudget;

	while (true) {
		const { pullRequests, nextCursor } = await fetchPullRequestPage(
			config.octokit,
			config.owner,
			config.repo,
			config.baseRef,
			cursor,
		);

		const unknownPRs: OpenPullRequest[] = [];
		for (const pull of pullRequests) {
			if (pull.mergeable === "UNKNOWN") {
				unknownPRs.push(pull);
				continue;
			}
			statuses[pull.number] = await reconcilePullRequest(config, pull);
		}

		if (unknownPRs.length > 0) {
			if (budget <= 0) {
				for (const pull of unknownPRs) {
					core.warning(
						`PR #${pull.number} "${pull.title}" stayed UNKNOWN after exhausting retries; skipping.`,
					);
				}
			} else {
				core.info(
					`${unknownPRs.length} pull request(s) returned UNKNOWN. Sleeping ${config.retryAfterMs / 1000}s before retry (${budget} retries left).`,
				);
				await sleep(config.retryAfterMs);
				budget -= 1;
				continue;
			}
		}

		if (!nextCursor) break;
		cursor = nextCursor;
	}

	return statuses;
}
