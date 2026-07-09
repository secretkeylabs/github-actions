import { Octokit } from "octokit";

const token = process.env.GITHUB_TOKEN;
const repoFullName = process.env.GITHUB_REPOSITORY;
const prNumber = process.env.PR_NUMBER;
const packageName = process.env.PACKAGE_NAME;
const version = process.env.PACKAGE_VERSION;

if (!token || !repoFullName || !prNumber || !packageName || !version) {
  console.error("Missing required environment variables.");
  process.exit(1);
}

const [owner, repo] = repoFullName.split("/") as [string, string];

const startMarker = "<" + "!-- package-pre-release-info-start --" + ">";
const endMarker = "<" + "!-- package-pre-release-info-end --" + ">";

const timestamp = new Date().toISOString();

const infoText = `${startMarker}
### Package pre-release info

Built at (UTC): ${timestamp}

\`\`\`bash
npm install ${packageName}@${version} -E
\`\`\`

\`\`\`bash
bun install ${packageName}@${version} -E
\`\`\`

---
${endMarker}`;

const octokit = new Octokit({ auth: token });

async function updatePullRequest() {
  try {
    const { data: pr } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: Number(prNumber),
    });

    let body = pr.body || "";

    const regex = new RegExp(`${startMarker}[\\s\\S]*?${endMarker}\\s*`);

    // Prepend the new info block
    if (regex.test(body)) {
      // If it exists, replace exactly that block, leaving the rest of the PR untouched
      body = body.replace(regex, `${infoText}\n\n`);
      console.log(`Updated existing info block in PR #${prNumber}.`);
    } else {
      // If it doesn't exist, prepend it to the very top
      body = `${infoText}\n\n${body}`;
      console.log(`Prepended new info block to PR #${prNumber}.`);
    }

    await octokit.rest.pulls.update({
      owner,
      repo,
      pull_number: Number(prNumber),
      body,
    });

    console.log(
      `Successfully added package pre-release info to PR #${prNumber}.`,
    );
  } catch (error) {
    console.error("Failed to update PR with package pre-release info.", error);
    process.exit(1);
  }
}

updatePullRequest();
