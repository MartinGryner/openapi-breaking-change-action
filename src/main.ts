import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { compareApiSpecs, comparisonToMarkdown, parseApiSpec, type ApiComparison } from "./compare";

type FailOn = "breaking" | "review" | "never";

const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();

function input(name: string) {
  return (process.env[`INPUT_${name.toUpperCase()}`] ?? "").trim();
}

function escapeData(value: string) {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function escapeProperty(value: string) {
  return escapeData(value).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

function annotate(level: "error" | "warning" | "notice", title: string, message: string) {
  console.log(`::${level} title=${escapeProperty(title)}::${escapeData(message)}`);
}

function setOutput(name: string, value: string | number) {
  const file = process.env.GITHUB_OUTPUT;
  if (file) appendFileSync(file, `${name}=${value}\n`);
}

function writeSummary(markdown: string) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, `${markdown}\n`);
}

function readWorkspaceFile(path: string) {
  const fullPath = join(workspace, path);
  if (!existsSync(fullPath)) throw new Error(`File not found: ${path}`);
  return readFileSync(fullPath, "utf8");
}

// git show needs a path relative to the repository root, with forward slashes.
function gitPath(path: string) {
  return normalize(path).split(sep).join("/").replace(/^\.\//, "");
}

function defaultBaseRef() {
  const baseBranch = process.env.GITHUB_BASE_REF;
  return baseBranch ? `origin/${baseBranch}` : "HEAD~1";
}

function readFromGit(ref: string, path: string): string | null {
  try {
    return execFileSync("git", ["show", `${ref}:${gitPath(path)}`], { cwd: workspace, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const stderr = String((error as { stderr?: string }).stderr ?? "");
    // The file is new on this branch: there is no earlier contract to break.
    if (/does not exist in|exists on disk, but not in/.test(stderr)) return null;
    if (/unknown revision|bad revision|invalid object name|not a valid object name/i.test(stderr)) {
      throw new Error(`Git could not find ${ref}. Check out the repository with fetch-depth: 0 so the base branch is available, or set base-ref.`);
    }
    throw new Error(`git show ${ref}:${gitPath(path)} failed: ${stderr.trim() || (error as Error).message}`);
  }
}

function failOnInput(): FailOn {
  const value = (input("fail-on") || "breaking").toLowerCase();
  if (value === "breaking" || value === "review" || value === "never") return value;
  throw new Error(`fail-on must be breaking, review, or never (got "${value}")`);
}

function shouldFail(result: ApiComparison, failOn: FailOn) {
  if (failOn === "never") return false;
  if (failOn === "review") return result.counts.breaking + result.counts.review > 0;
  return result.counts.breaking > 0;
}

function run() {
  const failOn = failOnInput();
  const basePath = input("base");
  const headPath = input("head");
  const specPath = input("spec");

  let baseSource: string | null;
  let headSource: string;
  let baseLabel: string;
  let headLabel: string;

  if (basePath || headPath) {
    if (!basePath || !headPath) throw new Error("Set both base and head, or set spec instead.");
    baseSource = readWorkspaceFile(basePath);
    headSource = readWorkspaceFile(headPath);
    baseLabel = basePath;
    headLabel = headPath;
  } else if (specPath) {
    const baseRef = input("base-ref") || defaultBaseRef();
    headSource = readWorkspaceFile(specPath);
    baseSource = readFromGit(baseRef, specPath);
    baseLabel = `${specPath} at ${baseRef}`;
    headLabel = `${specPath} in this commit`;
    if (baseSource === null) {
      annotate("notice", "No earlier API description", `${specPath} does not exist at ${baseRef}, so there is nothing to compare against.`);
      writeSummary(`## OpenAPI compatibility\n\n\`${specPath}\` does not exist at \`${baseRef}\`, so there is no earlier contract to compare against.\n`);
      for (const [name, value] of [["breaking", 0], ["review", 0], ["compatible", 0], ["result", "skipped"]] as const) setOutput(name, value);
      return;
    }
  } else {
    throw new Error("Set spec (one file compared with its version at base-ref), or set both base and head.");
  }

  const result = compareApiSpecs(parseApiSpec(baseSource), parseApiSpec(headSource));
  const failed = shouldFail(result, failOn);

  for (const change of result.changes) {
    if (change.severity === "breaking") annotate("error", "Breaking API change", `${change.message} (${change.path}). ${change.explanation}`);
    else if (change.severity === "review") annotate("warning", "API change needs review", `${change.message} (${change.path}). ${change.explanation}`);
  }
  for (const warning of result.warnings) annotate("warning", "OpenAPI comparison warning", warning);

  const report = comparisonToMarkdown(result).replace("# OpenAPI compatibility report", `# OpenAPI compatibility report\n\nCompared \`${baseLabel}\` with \`${headLabel}\`.`);
  const reportPath = join(process.env.RUNNER_TEMP ?? workspace, "openapi-compatibility-report.md");
  writeFileSync(reportPath, report);
  writeSummary(`${report}\nChecked with [OpenAPI Breaking Change Checker](https://martingruner.com/tools/openapi-breaking-change-checker).\n`);

  setOutput("breaking", result.counts.breaking);
  setOutput("review", result.counts.review);
  setOutput("compatible", result.counts.compatible);
  setOutput("result", failed ? "fail" : "pass");
  setOutput("report", reportPath);

  console.log(`Breaking: ${result.counts.breaking}, needs review: ${result.counts.review}, compatible: ${result.counts.compatible}.`);
  if (failed) {
    const what = failOn === "review" ? "breaking or review-needed changes" : "breaking changes";
    annotate("error", "OpenAPI check failed", `Found ${what} (fail-on: ${failOn}). See the job summary for the full report.`);
    process.exitCode = 1;
  }
}

try {
  run();
} catch (error) {
  annotate("error", "OpenAPI check could not run", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
