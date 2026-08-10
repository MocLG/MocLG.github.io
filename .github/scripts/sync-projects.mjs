#!/usr/bin/env node
// Regenerates the PROJECTS array in index.html from the GitHub GraphQL API.
// Pinned repositories lead the list in pin order; every other public repo follows.
// Any API or shape error exits non-zero WITHOUT touching index.html.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const LOGIN = "MocLG";
const START = "// <!-- PROJECTS:START -->";
const END = "// <!-- PROJECTS:END -->";
const INDENT = "        ";
const ACTIVE_START = "<!-- ACTIVE:START -->";
const ACTIVE_END = "<!-- ACTIVE:END -->";
const FORK_TAG = "Fork";
const NO_DESCRIPTION = "No description provided.";

const HTML_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../index.html");

const token = process.env.GITHUB_TOKEN;
if (!token) {
    fail("GITHUB_TOKEN is not set.");
}

function fail(message) {
    console.error(`sync-projects: ${message}`);
    process.exit(1);
}

const REPO_FIELDS = `
    name
    description
    url
    stargazerCount
    forkCount
    isFork
    isArchived
    primaryLanguage { name }
    licenseInfo { spdxId }
    defaultBranchRef { name }
    repositoryTopics(first: 6) { nodes { topic { name } } }
`;

const QUERY = `
query($login: String!, $cursor: String) {
    user(login: $login) {
        pinnedItems(first: 6, types: REPOSITORY) {
            nodes { ... on Repository { ${REPO_FIELDS} } }
        }
        repositories(
            first: 100
            after: $cursor
            privacy: PUBLIC
            ownerAffiliations: OWNER
            orderBy: { field: STARGAZERS, direction: DESC }
        ) {
            pageInfo { hasNextPage endCursor }
            nodes { ${REPO_FIELDS} }
        }
    }
}`;

async function graphql(cursor) {
    let response;
    try {
        response = await fetch("https://api.github.com/graphql", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
                "User-Agent": `${LOGIN}-site-sync`
            },
            body: JSON.stringify({ query: QUERY, variables: { login: LOGIN, cursor } })
        });
    } catch (error) {
        fail(`network error contacting the GraphQL API: ${error.message}`);
    }

    if (!response.ok) {
        fail(`GraphQL API returned HTTP ${response.status} ${response.statusText}.`);
    }

    let payload;
    try {
        payload = await response.json();
    } catch (error) {
        fail(`GraphQL response was not valid JSON: ${error.message}`);
    }

    if (payload.errors?.length) {
        fail(`GraphQL errors: ${payload.errors.map((error) => error.message).join("; ")}`);
    }

    const user = payload.data?.user;
    if (!user) {
        fail(`GraphQL response contained no user "${LOGIN}".`);
    }

    return user;
}

function assertRepoShape(node, source) {
    if (!node || typeof node !== "object") {
        fail(`${source} contained a non-object node.`);
    }
    if (typeof node.name !== "string" || node.name === "") {
        fail(`${source} contained a node with no name.`);
    }
    if (typeof node.url !== "string" || !node.url.startsWith("https://github.com/")) {
        fail(`${source} node "${node.name}" had an unexpected url: ${node.url}`);
    }
    if (!Number.isInteger(node.stargazerCount) || !Number.isInteger(node.forkCount)) {
        fail(`${source} node "${node.name}" had non-integer star/fork counts.`);
    }
    if (typeof node.isFork !== "boolean") {
        fail(`${source} node "${node.name}" was missing isFork.`);
    }
    if (!node.repositoryTopics || !Array.isArray(node.repositoryTopics.nodes)) {
        fail(`${source} node "${node.name}" was missing repositoryTopics.`);
    }
}

// Reads the current array so repos with no GitHub topics keep their hand-written tags.
function readExistingRegion(html) {
    const startIndex = html.indexOf(START);
    const endIndex = html.indexOf(END);

    if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
        fail(`could not find the ${START} / ${END} sentinels in index.html.`);
    }

    const body = html.slice(startIndex + START.length, endIndex);

    let existing;
    try {
        existing = new Function(`${body}\nreturn PROJECTS;`)();
    } catch (error) {
        fail(`the existing PROJECTS region did not parse as JavaScript: ${error.message}`);
    }

    if (!Array.isArray(existing)) {
        fail("the existing PROJECTS region did not evaluate to an array.");
    }

    return { startIndex, endIndex, existing };
}

function toProject(node, existingTags, existingDescriptions) {
    const key = node.name.toLowerCase();

    const topics = node.repositoryTopics.nodes
        .map((entry) => entry?.topic?.name)
        .filter((name) => typeof name === "string" && name !== "");

    const language = node.primaryLanguage?.name ?? null;
    const license = node.licenseInfo?.spdxId && node.licenseInfo.spdxId !== "NOASSERTION"
        ? node.licenseInfo.spdxId
        : null;

    let tags = topics;
    if (tags.length === 0) {
        tags = existingTags.get(key) ?? (language ? [language] : ["Repository"]);
    }

    // The page's existing convention is a "Fork" tag; derive it from isFork so it is
    // always present on forks and never left behind on a repo that stopped being one.
    tags = tags.filter((tag) => tag.toLowerCase() !== FORK_TAG.toLowerCase());
    if (node.isFork) {
        tags = [...tags, FORK_TAG];
    }

    // Hand-written copy in index.html wins; the API only fills in repos with no copy yet.
    const description = existingDescriptions.get(key)
        ?? (node.description?.trim() || NO_DESCRIPTION);

    return {
        name: node.name,
        url: node.url,
        description,
        language,
        stars: node.stargazerCount,
        forks: node.forkCount,
        license,
        defaultBranch: node.defaultBranchRef?.name ?? "main",
        fork: node.isFork,
        tags
    };
}

function renderProject(project) {
    const lines = [
        `${INDENT}    {`,
        `${INDENT}        name: ${JSON.stringify(project.name)},`,
        `${INDENT}        url: ${JSON.stringify(project.url)},`,
        `${INDENT}        description: ${JSON.stringify(project.description)},`,
        `${INDENT}        language: ${project.language === null ? "null" : JSON.stringify(project.language)},`,
        `${INDENT}        stars: ${project.stars},`,
        `${INDENT}        forks: ${project.forks},`,
        `${INDENT}        license: ${project.license === null ? "null" : JSON.stringify(project.license)},`,
        `${INDENT}        defaultBranch: ${JSON.stringify(project.defaultBranch)},`,
        `${INDENT}        fork: ${project.fork},`,
        `${INDENT}        tags: [${project.tags.map((tag) => JSON.stringify(tag)).join(", ")}]`,
        `${INDENT}    }`
    ];

    return lines.join("\n");
}

function renderRegion(projects) {
    return [
        "",
        `${INDENT}const PROJECTS = [`,
        projects.map(renderProject).join(",\n"),
        `${INDENT}];`,
        INDENT
    ].join("\n");
}

// The Active Development cards are hand-curated (toplines, tag rows, extra links), so
// only the "N stars" / "N forks" spans are rewritten. All other markup stays byte-identical.
function syncActiveRegion(html, statsByName) {
    const startIndex = html.indexOf(ACTIVE_START);
    const endIndex = html.indexOf(ACTIVE_END);

    if (startIndex === -1 || endIndex === -1) {
        return html;
    }
    if (endIndex < startIndex) {
        fail(`${ACTIVE_END} appears before ${ACTIVE_START} in index.html.`);
    }

    const region = html.slice(startIndex + ACTIVE_START.length, endIndex);

    const patched = region.replace(/<article\b[\s\S]*?<\/article>/g, (card) => {
        const heading = /<h3>([^<]+)<\/h3>/.exec(card);
        if (!heading) {
            fail("an Active Development card had no <h3> repo name.");
        }

        const stats = statsByName.get(heading[1].trim().toLowerCase());
        if (!stats) {
            fail(`Active Development card "${heading[1].trim()}" matched no public repository.`);
        }

        return card
            .replace(/<span>\d+ stars?<\/span>/g, `<span>${plural(stats.stars, "star")}</span>`)
            .replace(/<span>\d+ forks?<\/span>/g, `<span>${plural(stats.forks, "fork")}</span>`);
    });

    return html.slice(0, startIndex + ACTIVE_START.length) + patched + html.slice(endIndex);
}

function plural(value, noun) {
    return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

async function main() {
    const html = readFileSync(HTML_PATH, "utf8");
    const { startIndex, endIndex, existing } = readExistingRegion(html);

    const existingTags = new Map(
        existing
            .filter((project) => project?.name && Array.isArray(project.tags) && project.tags.length > 0)
            .map((project) => [project.name.toLowerCase(), project.tags])
    );

    // A placeholder is treated as "no copy written yet" so the API can still fill it in later.
    const existingDescriptions = new Map(
        existing
            .filter((project) => project?.name
                && typeof project.description === "string"
                && project.description.trim() !== ""
                && project.description.trim() !== NO_DESCRIPTION)
            .map((project) => [project.name.toLowerCase(), project.description.trim()])
    );

    const first = await graphql(undefined);

    if (!first.pinnedItems || !Array.isArray(first.pinnedItems.nodes)) {
        fail("GraphQL response had no pinnedItems.nodes array.");
    }
    if (first.pinnedItems.nodes.length === 0) {
        fail("GraphQL returned zero pinned repositories; refusing to rewrite the page.");
    }
    first.pinnedItems.nodes.forEach((node) => assertRepoShape(node, "pinnedItems"));

    const allRepos = [];
    let page = first;
    let guard = 0;
    for (;;) {
        if (!page.repositories || !Array.isArray(page.repositories.nodes)) {
            fail("GraphQL response had no repositories.nodes array.");
        }
        page.repositories.nodes.forEach((node) => assertRepoShape(node, "repositories"));
        allRepos.push(...page.repositories.nodes);

        if (!page.repositories.pageInfo?.hasNextPage) {
            break;
        }
        if (++guard > 20) {
            fail("repository pagination did not terminate.");
        }
        page = await graphql(page.repositories.pageInfo.endCursor);
    }

    if (allRepos.length === 0) {
        fail("GraphQL returned zero public repositories; refusing to rewrite the page.");
    }

    // Pinned first, in pin order; then the remaining public repos by stars desc, name asc.
    const pinnedNames = new Set(first.pinnedItems.nodes.map((node) => node.name));
    const rest = allRepos
        .filter((node) => !pinnedNames.has(node.name) && !node.isArchived)
        .sort((a, b) => b.stargazerCount - a.stargazerCount || a.name.localeCompare(b.name));

    const projects = [...first.pinnedItems.nodes, ...rest]
        .map((node) => toProject(node, existingTags, existingDescriptions));

    const statsByName = new Map(
        projects.map((project) => [project.name.toLowerCase(), { stars: project.stars, forks: project.forks }])
    );

    const withProjects = html.slice(0, startIndex + START.length) + renderRegion(projects) + html.slice(endIndex);
    const updated = syncActiveRegion(withProjects, statsByName);

    if (updated === html) {
        console.log(`sync-projects: no change (${projects.length} repositories).`);
        return;
    }

    writeFileSync(HTML_PATH, updated);
    console.log(`sync-projects: rewrote PROJECTS with ${projects.length} repositories.`);
}

await main();
