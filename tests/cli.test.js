import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const worker = fileURLToPath(new URL("../scripts/worker.mjs", import.meta.url));
function run(args = [], env = {}) {
  return spawnSync(process.execPath, [worker, ...args], {
    cwd: tmpdir(), env, encoding: "utf8", timeout: 5000,
  });
}

test("standalone CLI loads its email assets outside the repository and defaults to disabled", () => {
  const result = run();
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    status: "disabled", dryRun: false, issueCount: 0, itemCount: 0,
  });
});

test("dry run rejects missing source config and malformed flags cannot launch the worker", () => {
  const preview = run(["--dry-run"]);
  assert.equal(preview.status, 1);
  assert.equal(JSON.parse(preview.stdout).status, "invalid_config");
  const invalid = run(["--send-all"]);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Usage:/);
  assert.equal(invalid.stdout, "");
});
