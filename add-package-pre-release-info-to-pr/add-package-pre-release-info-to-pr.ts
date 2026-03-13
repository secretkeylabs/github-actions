const token = process.env.GITHUB_TOKEN;
const repoFullName = process.env.GITHUB_REPOSITORY;
const prNumber = process.env.PR_NUMBER;
const packageName = process.env.PACKAGE_NAME;
const version = process.env.PACKAGE_VERSION;

if (!token || !repoFullName || !prNumber || !packageName || !version) {
  console.error("Missing required environment variables.");
  process.exit(1);
}

const startMarker = "<" + "!-- package-pre-release-info-start --" + ">";
const endMarker = "<" + "!-- package-pre-release-info-end --" + ">";

const infoText = `${startMarker}
### Package pre-release info

\`\`\`bash
npm install ${packageName}@${version} -E
\`\`\`

\`\`\`bash
bun install ${packageName}@${version} -E
\`\`\`

---
${endMarker}`;

const apiUrl = `https://api.github.com/repos/${repoFullName}/pulls/${prNumber}`;
const headers = {
  Accept: "application/vnd.github.v3+json",
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2022-11-28",
  "Content-Type": "application/json",
};

async function updatePullRequest() {
  try {
    const getRes = await fetch(apiUrl, { headers });
    if (!getRes.ok) throw new Error(`Failed to fetch PR: ${getRes.statusText}`);

    const pr = await getRes.json();
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

    const patchRes = await fetch(apiUrl, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ body }),
    });

    if (!patchRes.ok)
      throw new Error(`Failed to update PR: ${patchRes.statusText}`);

    console.log(
      `Successfully added package pre-release info to PR #${prNumber}.`,
    );
  } catch (error) {
    console.error("Failed to update PR with package pre-release info.", error);
    process.exit(1);
  }
}

updatePullRequest();
