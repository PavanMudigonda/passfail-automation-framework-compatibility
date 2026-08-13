import { readFile } from "node:fs/promises";
import { createEvidenceEnvelope, createTestCheckEvaluation, parseTestResult, publishTestResults } from "./publish-test-results.mjs";
import { flattenFrameworkMatrix } from "../lib/frameworks.mjs";

const evidenceEndpoint = process.env.PASSFAIL_TEST_RESULTS_URL ?? "http://localhost:30081/api/evidence-reports";
const checkEndpoint = process.env.PASSFAIL_CHECK_EVALUATIONS_URL ?? evidenceEndpoint.replace(/\/evidence-reports$/, "/check-evaluations");
const matrix = JSON.parse(await readFile(new URL("../automation-framework-matrix.json", import.meta.url), "utf8"));
const entries = flattenFrameworkMatrix(matrix);
const uploadGeneration = process.env.PASSFAIL_UPLOAD_GENERATION ?? "v2";
const envelopes = [];

for (const framework of entries) {
  const source = new URL(`../reports/${framework.id}.xml`, import.meta.url);
  const content = await readFile(source, "utf8");
  const environment = {
    ...process.env,
    PASSFAIL_TEST_RESULT_FILES: source.pathname,
    PASSFAIL_TEST_RESULTS_URL: evidenceEndpoint,
    PASSFAIL_CHECK_EVALUATIONS_URL: checkEndpoint,
    PASSFAIL_PUBLISH_CHECK_EVALUATION: "false",
    PASSFAIL_PLAN_REVISION_ID: process.env.PASSFAIL_PLAN_REVISION_ID ?? "automation-framework-matrix-v1",
    PASSFAIL_TEST_PURPOSE: "e2e",
    PASSFAIL_TEST_FRAMEWORK: framework.displayName,
    PASSFAIL_SUBJECT_KEY: process.env.PASSFAIL_SUBJECT_KEY ?? "automation-framework-compatibility",
    PASSFAIL_REPOSITORY_ID: process.env.PASSFAIL_REPOSITORY_ID ?? "passfail-automation-framework-compatibility",
    PASSFAIL_UPLOAD_ID: `automation-framework-${framework.id}-${uploadGeneration}`
  };
  await publishTestResults({ environment });
  const envelope = createEvidenceEnvelope({
    source: source.pathname,
    content,
    parsed: parseTestResult(source.pathname, content),
    environment
  });
  envelopes.push(envelope);
}

const checkEnvironment = {
  ...process.env,
  PASSFAIL_PLAN_REVISION_ID: process.env.PASSFAIL_PLAN_REVISION_ID ?? "automation-framework-matrix-v1",
  PASSFAIL_TEST_PURPOSE: "e2e",
  PASSFAIL_SUBJECT_KEY: process.env.PASSFAIL_SUBJECT_KEY ?? "automation-framework-compatibility",
  PASSFAIL_REPOSITORY_ID: process.env.PASSFAIL_REPOSITORY_ID ?? "passfail-automation-framework-compatibility",
  PASSFAIL_TEST_REPORT_NAME: process.env.PASSFAIL_TEST_REPORT_NAME ?? "Automation framework compatibility"
};
const check = await post(checkEndpoint, createTestCheckEvaluation({ envelopes, environment: checkEnvironment }));
console.log(`Published ${envelopes.length} automation framework compatibility reports and check ${check.checkEvaluationId ?? "created"}`);

async function post(endpoint, body) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const responseBody = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${endpoint} returned ${response.status}: ${JSON.stringify(responseBody)}`);
  return responseBody;
}
