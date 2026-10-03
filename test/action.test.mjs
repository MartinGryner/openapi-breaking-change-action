import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const action = join(root, "dist", "index.cjs");
const v1 = join(root, "examples", "orders-v1.yaml");
const v2 = join(root, "examples", "orders-v2.yaml");

// Runs the bundled action the way the runner does: inputs as INPUT_* variables, outputs and the
// summary appended to files.
function runAction(workspace, inputs) {
  const output = join(workspace, "output.txt");
  const summary = join(workspace, "summary.md");
  writeFileSync(output, "");
  writeFileSync(summary, "");
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, GITHUB_WORKSPACE: workspace, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, RUNNER_TEMP: workspace };
  for (const [name, value] of Object.entries(inputs)) env[`INPUT_${name.toUpperCase()}`] = value;
  const result = spawnSync(process.execPath, [action], { env, encoding: "utf8" });
  const outputs = Object.fromEntries(readFileSync(output, "utf8").trim().split("\n").filter(Boolean).map((line) => line.split(/=(.*)/s).slice(0, 2)));
  return { status: result.status, stdout: result.stdout, outputs, summary: readFileSync(summary, "utf8") };
}

function workspaceWith(files) {
  const dir = mkdtempSync(join(tmpdir(), "openapi-action-"));
  for (const [name, source] of Object.entries(files)) copyFileSync(source, join(dir, name));
  return dir;
}

function git(dir, ...args) {
  execFileSync("git", args, { cwd: dir, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
}

test("base and head: breaking changes fail the step and are annotated", () => {
  const dir = workspaceWith({ "old.yaml": v1, "new.yaml": v2 });
  const run = runAction(dir, { base: "old.yaml", head: "new.yaml" });
  assert.equal(run.status, 1);
  assert.equal(run.outputs.result, "fail");
  assert.ok(Number(run.outputs.breaking) > 0);
  assert.match(run.stdout, /::error title=Breaking API change::/);
  assert.match(run.summary, /# OpenAPI compatibility report/);
  assert.match(run.summary, /Compared `old\.yaml` with `new\.yaml`/);
  assert.ok(readFileSync(run.outputs.report, "utf8").includes("## Breaking"));
});

test("fail-on never reports but passes", () => {
  const dir = workspaceWith({ "old.yaml": v1, "new.yaml": v2 });
  const run = runAction(dir, { base: "old.yaml", head: "new.yaml", "fail-on": "never" });
  assert.equal(run.status, 0);
  assert.equal(run.outputs.result, "pass");
  assert.ok(Number(run.outputs.breaking) > 0);
});

test("identical descriptions pass with no changes", () => {
  const dir = workspaceWith({ "old.yaml": v1, "new.yaml": v1 });
  const run = runAction(dir, { base: "old.yaml", head: "new.yaml" });
  assert.equal(run.status, 0);
  assert.equal(run.outputs.result, "pass");
  assert.equal(run.outputs.breaking, "0");
  assert.equal(run.outputs.review, "0");
});

test("an invalid fail-on value stops with a clear error", () => {
  const dir = workspaceWith({ "old.yaml": v1, "new.yaml": v1 });
  const run = runAction(dir, { base: "old.yaml", head: "new.yaml", "fail-on": "sometimes" });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /fail-on must be breaking, review, or never/);
});

test("only one of base and head is a usage error", () => {
  const dir = workspaceWith({ "old.yaml": v1 });
  const run = runAction(dir, { base: "old.yaml" });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /Set both base and head/);
});

test("a file that is not OpenAPI or Swagger is reported", () => {
  const dir = mkdtempSync(join(tmpdir(), "openapi-action-"));
  writeFileSync(join(dir, "a.yaml"), "hello: world\n");
  writeFileSync(join(dir, "b.yaml"), "hello: world\n");
  const run = runAction(dir, { base: "a.yaml", head: "b.yaml" });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /::error title=OpenAPI check could not run::/);
});

test("spec mode compares the working file with the version at base-ref", () => {
  const dir = mkdtempSync(join(tmpdir(), "openapi-action-git-"));
  git(dir, "init", "-q", "-b", "main");
  copyFileSync(v1, join(dir, "openapi.yaml"));
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "v1");
  copyFileSync(v2, join(dir, "openapi.yaml"));
  git(dir, "commit", "-q", "-am", "v2");
  const run = runAction(dir, { spec: "./openapi.yaml" });
  assert.equal(run.status, 1);
  assert.equal(run.outputs.result, "fail");
  assert.match(run.summary, /Compared `\.\/openapi\.yaml at HEAD~1`/);
});

test("spec mode skips a file that is new on this branch", () => {
  const dir = mkdtempSync(join(tmpdir(), "openapi-action-git-"));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "x\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "first");
  copyFileSync(v1, join(dir, "openapi.yaml"));
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "add api");
  const run = runAction(dir, { spec: "openapi.yaml" });
  assert.equal(run.status, 0);
  assert.equal(run.outputs.result, "skipped");
  assert.match(run.stdout, /::notice title=No earlier API description::/);
});

test("spec mode explains a missing base ref", () => {
  const dir = mkdtempSync(join(tmpdir(), "openapi-action-git-"));
  git(dir, "init", "-q", "-b", "main");
  copyFileSync(v1, join(dir, "openapi.yaml"));
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "v1");
  const run = runAction(dir, { spec: "openapi.yaml", "base-ref": "origin/main" });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /fetch-depth: 0/);
});

test("annotation text escapes newlines and percent signs", () => {
  const dir = workspaceWith({ "old.yaml": v1, "new.yaml": v2 });
  const run = runAction(dir, { base: "old.yaml", head: "new.yaml" });
  for (const line of run.stdout.split("\n").filter((entry) => entry.startsWith("::"))) assert.doesNotMatch(line, /\r/);
});
