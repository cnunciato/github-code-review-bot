import { execSync } from "child_process";
import { Pipeline } from "@buildkite/buildkite-sdk";
import { Octokit } from "octokit";

interface WebhookPayload {
    action?: string;
    label: {
        name: string;
    };
    pull_request: {
        number: number;
        head: {
            ref: string;
        };
    };
    repository: {
        owner: {
            login: string;
        };
        name: string;
    };
}

interface BuildkiteBuild {
    number: number;
    web_url: string;
    state: string;
    commit: string;
}

/**
 * Creates an authenticated Octokit instance
 */
function createOctokit(): Octokit {
    const githubToken = process.env.GITHUB_TOKEN;
    if (!githubToken) {
        throw new Error("GITHUB_TOKEN not set");
    }

    return new Octokit({ auth: githubToken });
}

/**
 * Gets the head commit SHA for a PR
 */
async function getPrHeadCommit(
    octokit: Octokit,
    prNumber: number,
    repoOwner: string,
    repoName: string,
): Promise<string | null> {
    console.error(`Getting head commit for PR #${prNumber}...`);

    const { data: pr } = await octokit.rest.pulls.get({
        owner: repoOwner,
        repo: repoName,
        pull_number: prNumber,
    });

    const commitSha = pr.head.sha;

    if (commitSha) {
        console.error(`PR #${prNumber} head commit: ${commitSha}`);
        return commitSha;
    } else {
        console.error(`Could not get head commit for PR #${prNumber}`);
        return null;
    }
}

/**
 * Generates the pipeline using the Buildkite SDK
 */
function generateCodeReviewPipeline(webhookPullRequestUrl: string, agentBuildUrl: string): string {
    const pipeline = new Pipeline();

    const tokenArgs = [`PullRequestURL=${webhookPullRequestUrl}`, `AgentBuildURL=${agentBuildUrl}`];

    pipeline.addStep({
        id: "agent",
        label: ":buildkite: Fixing the build",
        commands: [...runAgent(tokenArgs)],
        plugins: {
            docker: {
                image: "buildkite-agentic-example-tools:latest",
                "mount-checkout": false,
                "mount-buildkite-agent": true,
                environment: [
                    "BUILDKITE",
                    "BUILDKITE_AGENT_ENDPOINT",
                    "BUILDKITE_AGENT_ACCESS_TOKEN",
                    "BUILDKITE_API_TOKEN",
                    "BUILDKITE_BUILD_URL",
                    "BUILDKITE_MCP_SERVER_VERSION",
                    "GITHUB_CLI_VERSION",
                    "GITHUB_TOKEN",
                    "TRIGGER_ON_LABEL",
                    "MODEL_PROVIDER",
                ],
            },
        },
        secrets: {
            GITHUB_TOKEN: "GITHUB_TOKEN",
            BUILDKITE_API_TOKEN: "API_TOKEN_BUILDKITE",
        },
    });

    return pipeline.toYAML();
}

function runAgent(tokenArgs: string[] = []): string[] {
    const provider = process.env.MODEL_PROVIDER;

    if (provider === "anthropic") {
        return [`./scripts/claude.sh prompts/user.md ${tokenArgs.join(" ")}`];
    }

    return [
        "echo '--- :no_entry_sign: Missing or unsupported MODEL_PROVIDER'",
        `echo "Supported model providers are 'anthropic', 'openai'."`,
        "echo 'Use the MODEL_PROVIDER environment variable to set one.'",
        "exit 1",
    ];
}

/**
 * Executes a buildkite-agent command
 */
function buildkiteAgent(...args: string[]): string {
    const command = `buildkite-agent ${args.join(" ")}`;
    return execSync(command, { encoding: "utf-8" });
}

/**
 * Main processing logic
 */
async function main() {
    console.log("--- :github: Processing webhook");

    const webhookPayload = buildkiteAgent("meta-data", "get", "buildkite:webhook").trim();

    if (!webhookPayload) {
        console.error("Error: No webhook payload found");
        process.exit(1);
    }

    console.log("Received webhook payload:");
    const payload: WebhookPayload = JSON.parse(webhookPayload);
    console.log(JSON.stringify(payload, null, 2));

    const webhookEvent = payload.action;

    if (!webhookEvent) {
        console.error("Webhook detected, but couldn't determine webhook event. Exiting.");
        process.exit(0);
    }

    console.log(`Webhook event: ${webhookEvent}`);

    if (webhookEvent !== "labeled") {
        console.log("Not a labeled event, exiting");
        process.exit(0);
    }

    buildkiteAgent("meta-data", "set", "webhook:event", webhookEvent);
    buildkiteAgent("meta-data", "set", "webhook:source", "github");

    const labelName = payload.label.name;
    const prNumber = payload.pull_request.number;
    const prBranch = payload.pull_request.head.ref;
    const repoOwner = payload.repository.owner.login;
    const repoName = payload.repository.name;

    console.log(`Label: ${labelName}`);
    console.log(`PR number: ${prNumber}`);
    console.log(`PR branch: ${prBranch}`);
    console.log(`Repository: ${repoOwner}/${repoName}`);

    if (labelName !== process.env.TRIGGER_ON_LABEL) {
        console.log(`Label is not '${process.env.TRIGGER_ON_LABEL}', exiting`);
        process.exit(0);
    }

    console.log("Label detected, checking for failed builds...");

    // BUG: This currently assumes the orgSlug and pipelineSlug use the same
    // names as the GitHub org and repo, respectively, which often won't be the case.
    const pipelineSlug = repoName.replace(".", "-dot-");
    const orgSlug = repoOwner;

    // Create Octokit instance for GitHub API calls
    const octokit = createOctokit();

    const prHeadCommit = await getPrHeadCommit(octokit, prNumber, repoOwner, repoName);

    if (!prHeadCommit) {
        console.log("Could not get PR head commit, skipping pipeline upload");
        process.exit(0);
    }

    const webhookPullRequestUrl = `https://github.com/${repoOwner}/${repoName}/pull/${prNumber}`;

    // Post acknowledgement comment on the PR
    const agentBuildUrl = process.env.BUILDKITE_BUILD_URL || "";
    const acknowledgementBody = `I'm on it! 🛠️\n\nYou can follow my progress here: ${agentBuildUrl}`;

    try {
        await octokit.rest.issues.createComment({
            owner: repoOwner,
            repo: repoName,
            issue_number: prNumber,
            body: acknowledgementBody,
        });
        console.log("Posted acknowledgement comment on PR");
    } catch (error) {
        console.error("Failed to post acknowledgement comment:", error);
        // Continue with pipeline upload even if comment fails
    }

    // Set environment variables for the pipeline
    process.env.WEBHOOK_PIPELINE_SLUG = pipelineSlug;
    process.env.WEBHOOK_PULL_REQUEST_URL = webhookPullRequestUrl;

    const pipelineYaml = generateCodeReviewPipeline(
        webhookPullRequestUrl,
        process.env.BUILDKITE_BUILD_URL || "",
    );

    // Upload the pipeline
    const uploadProcess = execSync("buildkite-agent pipeline upload", {
        input: pipelineYaml,
        encoding: "utf-8",
    });

    console.log(uploadProcess);
}

// Run the main function
main().catch(error => {
    console.error("Error:", error.message);
    process.exit(1);
});
