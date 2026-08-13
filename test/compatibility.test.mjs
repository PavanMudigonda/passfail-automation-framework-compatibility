import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createEvidenceEnvelope, createTestCheckEvaluation, parseTestResult } from "../scripts/publish-test-results.mjs";
import { flattenFrameworkMatrix } from "../lib/frameworks.mjs";

const matrix = JSON.parse(await readFile(new URL("../automation-framework-matrix.json", import.meta.url), "utf8"));
const entries = flattenFrameworkMatrix(matrix);

test("covers every automation framework matrix entry", () => {
  assert.equal(entries.length, 91);
  assert.equal(new Set(entries.map((entry) => entry.id)).size, entries.length);
  assert.deepEqual(new Set(entries.map((entry) => entry.executionSurface)), new Set(["Web automation", "Mobile automation"]));
});

for (const framework of entries) {
  test(`${framework.id} creates passing PassFail evidence`, async () => {
    const source = new URL(`../reports/${framework.id}.xml`, import.meta.url);
    const content = await readFile(source, "utf8");
    const parsed = parseTestResult(source.pathname, content);
    const environment = {
      PASSFAIL_PLAN_REVISION_ID: "automation-framework-matrix-v1",
      PASSFAIL_TEST_PURPOSE: "e2e",
      PASSFAIL_TEST_FRAMEWORK: framework.displayName,
      PASSFAIL_SUBJECT_KEY: "automation-framework-compatibility",
      PASSFAIL_REPOSITORY_ID: "passfail-automation-framework-compatibility",
      PASSFAIL_UPLOAD_ID: `automation-framework-${framework.id}-v1`
    };
    const envelope = createEvidenceEnvelope({ source: source.pathname, content, parsed, environment });
    const check = createTestCheckEvaluation({ envelopes: [envelope], environment });
    const attempt = envelope.report.runs[0].suites[0].tests[0].attempts[0];

    assert.equal(envelope.report.details.framework, framework.displayName);
    assert.equal(envelope.report.runs[0].status, "PASSED");
    assert.equal(envelope.report.metrics.find((metric) => metric.name === "tests.total").value, 1);
    assert.equal(attempt.inferredSteps[0].details.category, "report-summary");
    assert.ok(attempt.logs[0].message.length > 0);
    assert.equal(attempt.logs[0].message, "Compatibility validation only; device-required entries do not claim a remote or hardware execution.");
    assert.equal(attempt.attachments[0].mediaType, "application/xml");
    assert.equal(check.status, "PASSED");
    assert.equal(check.metrics.totalTests, 1);
  });
}
