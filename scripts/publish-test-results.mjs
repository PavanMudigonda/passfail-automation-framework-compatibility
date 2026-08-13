import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { glob, readFile } from "node:fs/promises";
import { basename, dirname, extname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { XMLParser } from "fast-xml-parser";
import { workflowProvenance } from "./publish-coverage.mjs";
import { passfailRequestHeaders } from "./publish-auth.mjs";

const DEFAULT_ENDPOINT = "http://localhost:30081/api/evidence-reports";
const DEFAULT_CHECK_ENDPOINT = "http://localhost:30081/api/check-evaluations";

const xmlParser = new XMLParser({
  allowBooleanAttributes: true,
  attributeNamePrefix: "",
  ignoreAttributes: false,
  parseAttributeValue: false,
  textNodeName: "#text",
  trimValues: true
});

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") return String(value["#text"] ?? "");
  return String(value);
}

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function secondsToMilliseconds(value) {
  return Math.max(0, Math.round(finiteNumber(value) * 1000));
}

function dotnetDurationToMilliseconds(value) {
  const match = String(value ?? "").match(/^(?:(\d+)\.)?(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  if (!match) return 0;
  return Math.round((finiteNumber(match[1]) * 86400 + finiteNumber(match[2]) * 3600 + finiteNumber(match[3]) * 60 + finiteNumber(match[4])) * 1000);
}

function isoTimestamp(value) {
  if (value === undefined || value === null || value === "") return "";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

function dotnetSourceLocation(value) {
  for (const line of String(value ?? "").split(/\r?\n/)) {
    const stackLocation = line.match(/.*\b(?:in|en) (.+):(?:line|línea) (\d+)\s*$/i);
    const monoLocation = line.match(/.*\bin (.+):(\d+)\s*$/);
    const compilerLocation = line.match(/^\s*(.+)\((\d+),\d+\):\s+at\s/);
    const match = stackLocation ?? monoLocation ?? compilerLocation;
    if (match) {
      const path = match[1].replaceAll("\\", "/");
      if (!path.startsWith("<")) return { path, line: finiteNumber(match[2]) };
    }
  }
  return {};
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableId(prefix, ...parts) {
  return `${prefix}_${digest(parts.join("\u0000")).slice(0, 24)}`;
}

function normalizeStatus(value, node = {}, missingStatus = "INCOMPLETE") {
  if (node.failure !== undefined || node.error !== undefined) return "FAILED";
  if (node.skipped !== undefined) return "SKIPPED";
  const rawStatus = String(value ?? "").trim();
  if (!rawStatus) return missingStatus;
  const status = rawStatus.toLowerCase().replaceAll(/[_\s-]+/g, "");
  if (["pass", "passed", "success", "succeeded", "completed"].includes(status)) return "PASSED";
  if (["fail", "failed", "failure", "error", "broken"].includes(status)) return "FAILED";
  if (["skip", "skipped", "ignored", "notexecuted", "notrunnable", "pending", "disabled", "inconclusive"].includes(status)) return "SKIPPED";
  if (["cancelled", "canceled"].includes(status)) return "CANCELLED";
  if (status === "aborted") return "ABORTED";
  if (status === "interrupted") return "INTERRUPTED";
  if (status === "stopped") return "STOPPED";
  if (["timeout", "timedout"].includes(status)) return "TIMED_OUT";
  if (["flaky", "flaked"].includes(status)) return "FLAKED";
  if (["blocked"].includes(status)) return "BLOCKED";
  if (status === "queued") return "QUEUED";
  if (status === "running") return "RUNNING";
  if (status === "inprogress") return "IN_PROGRESS";
  if (status === "paused") return "PAUSED";
  if (status === "neutral") return "NEUTRAL";
  if (status === "notapplicable") return "NOT_APPLICABLE";
  if (status === "actionrequired") return "ACTION_REQUIRED";
  return "INCOMPLETE";
}

function aggregateStatus(items) {
  const statuses = items.map((item) => item.status);
  if (statuses.some((status) => status === "FAILED")) return "FAILED";
  if (statuses.some((status) => status === "TIMED_OUT")) return "TIMED_OUT";
  if (statuses.some((status) => status === "ABORTED")) return "ABORTED";
  if (statuses.some((status) => status === "INTERRUPTED")) return "INTERRUPTED";
  if (statuses.some((status) => status === "STOPPED")) return "STOPPED";
  if (statuses.some((status) => status === "CANCELLED")) return "CANCELLED";
  if (statuses.some((status) => ["INCOMPLETE", "BLOCKED", "RUNNING", "IN_PROGRESS", "QUEUED", "PAUSED", "ACTION_REQUIRED"].includes(status))) return "INCOMPLETE";
  if (statuses.some((status) => status === "FLAKED")) return "FLAKED";
  if (statuses.length > 0 && statuses.every((status) => status === "SKIPPED")) return "SKIPPED";
  if (statuses.some((status) => status === "PASSED")) return "PASSED";
  return "INCOMPLETE";
}

function isFailedStatus(status) {
  return ["FAILED", "TIMED_OUT", "CANCELLED", "ABORTED", "STOPPED", "INTERRUPTED"].includes(status);
}

function failureDetails(test) {
  const failure = asArray(test.failure ?? test.error)[0];
  if (failure === undefined) return {};
  const message = typeof failure === "object" ? String(failure.message ?? "") : "";
  const failureText = text(failure);
  return {
    ...(message ? { errorMessage: message } : {}),
    ...(typeof failure === "object" && failure.type ? { errorType: String(failure.type) } : {}),
    ...(failureText ? { errorDetails: failureText } : {})
  };
}

function outputLogs(stdout, stderr) {
  return [
    ...asArray(stdout).map(text).filter(Boolean).map((message) => ({ level: "info", message })),
    ...asArray(stderr).map(text).filter(Boolean).map((message) => ({ level: "error", message }))
  ];
}

function attachmentMediaType(path) {
  return ({
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".json": "application/json",
    ".log": "text/plain",
    ".png": "image/png",
    ".trx": "application/xml",
    ".txt": "text/plain",
    ".webm": "video/webm",
    ".xml": "application/xml",
    ".zip": "application/zip"
  })[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function fileAttachment(source, identity, value, index) {
  const localPath = resolve(dirname(resolve(source)), String(value).trim());
  const content = readFileSync(localPath);
  const checksum = `sha256:${digest(content)}`;
  return {
    attachmentId: stableId("artifact", source, identity, index, checksum),
    name: basename(localPath),
    mediaType: attachmentMediaType(localPath),
    checksum,
    sizeBytes: content.length,
    sensitivity: "INTERNAL",
    details: { localPath }
  };
}

function annotatedOutput(source, identity, stdout, stderr, resultFiles = []) {
  const logs = outputLogs(stdout, stderr);
  const steps = [];
  const attachments = [];
  const attachmentPaths = [];
  for (const message of [...asArray(stdout), ...asArray(stderr)].map(text)) {
    for (const rawLine of message.split(/\r?\n/)) {
      const line = rawLine.trim();
      const step = line.match(/^\[\[PASSFAIL_STEP\|([^|]+)\|(\d+(?:\.\d+)?)\|(.+)\]\]$/);
      if (step) {
        const name = step[3].trim();
        steps.push({
          stepId: stableId("step", source, identity, steps.length, name),
          name,
          status: normalizeStatus(step[1]),
          durationMs: Math.max(0, Math.round(finiteNumber(step[2]))),
          details: { category: "test.step", depth: 0, source: "report-annotation" }
        });
        continue;
      }
      const attachment = line.match(/^\[\[(?:PASSFAIL_)?ATTACHMENT\|(.+)\]\]$/);
      if (attachment) attachmentPaths.push(attachment[1]);
    }
  }
  attachmentPaths.push(...asArray(resultFiles).map((item) => typeof item === "object" ? item?.path : item).filter(Boolean));
  for (const path of [...new Set(attachmentPaths)]) {
    try {
      attachments.push(fileAttachment(source, identity, path, attachments.length));
    } catch (error) {
      logs.push({ level: "error", message: `Unable to attach ${path}: ${error.message}` });
    }
  }
  return { logs, steps, attachments };
}

function attempt(status, durationMs, details = {}) {
  const { logs = [], steps = [], attachments = [], startedAt, completedAt, ...attemptDetails } = details;
  const normalizedStartedAt = isoTimestamp(startedAt);
  const normalizedCompletedAt = isoTimestamp(completedAt);
  const errorLogs = [details.errorMessage, details.errorDetails]
    .map((message) => String(message || "").trim())
    .filter((message, index, messages) => message && messages.indexOf(message) === index)
    .map((message) => ({ level: "error", message }));
  return {
    attempt: 1,
    status,
    ...(normalizedStartedAt ? { startedAt: normalizedStartedAt } : {}),
    ...(normalizedCompletedAt ? { completedAt: normalizedCompletedAt } : {}),
    ...((errorLogs.length > 0 || logs.length > 0) ? { logs: [...errorLogs, ...logs] } : {}),
    ...(steps.length > 0 ? { steps } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    details: { durationMs, ...attemptDetails }
  };
}

function normalizedTest({ source, suiteName, name, className, file, line, status, durationMs, details = {} }) {
  const testName = String(name || "Unnamed test").trim();
  return {
    testId: stableId("test", source, suiteName, className, testName),
    name: testName,
    status,
    attempts: [attempt(status, durationMs, details)],
    details: {
      durationMs,
      ...(className ? { className: String(className) } : {}),
      ...(file ? { sourcePath: String(file).replaceAll("\\", "/") } : {}),
      ...(finiteNumber(line) > 0 ? { sourceLine: finiteNumber(line) } : {})
    }
  };
}

function normalizedSuite(source, name, tests, details = {}) {
  const suiteName = String(name || "Default suite").trim();
  return {
    suiteId: stableId("suite", source, suiteName),
    name: suiteName,
    status: aggregateStatus(tests),
    tests,
    details
  };
}

function buildRun(source, name, suites, { framework, startedAt, completedAt, durationMs, details = {} }) {
  const tests = suites.flatMap((suite) => suite.tests ?? []);
  const normalizedStartedAt = isoTimestamp(startedAt);
  const normalizedCompletedAt = isoTimestamp(completedAt);
  return {
    runId: stableId("run", source, name),
    name,
    status: aggregateStatus(tests),
    attempt: 1,
    ...(normalizedStartedAt ? { startedAt: normalizedStartedAt } : {}),
    ...(normalizedCompletedAt ? { completedAt: normalizedCompletedAt } : {}),
    suites,
    details: { framework, source, testCount: tests.length, durationMs, ...details }
  };
}

function junitSuites(source, node, inheritedName = "") {
  const suites = [];
  for (const suite of asArray(node)) {
    const suiteName = String(suite?.name || inheritedName || "Default suite");
    const tests = asArray(suite?.testcase).map((test) => {
      const status = normalizeStatus(test?.status, test, "PASSED");
      const durationMs = secondsToMilliseconds(test?.time);
      const output = annotatedOutput(
        source,
        `${suiteName}\u0000${test?.classname ?? ""}\u0000${test?.name ?? ""}`,
        test?.["system-out"] ?? suite?.["system-out"],
        test?.["system-err"] ?? suite?.["system-err"]
      );
      return normalizedTest({
        source,
        suiteName,
        name: test?.name,
        className: test?.classname,
        file: test?.file,
        line: test?.line,
        status,
        durationMs,
        details: {
          ...failureDetails(test),
          ...output
        }
      });
    });
    if (tests.length > 0) {
      suites.push(normalizedSuite(source, suiteName, tests, {
        ...(suite?.package ? { package: String(suite.package) } : {}),
        durationMs: secondsToMilliseconds(suite?.time)
      }));
    }
    suites.push(...junitSuites(source, suite?.testsuite, suiteName));
  }
  return suites;
}

export function parseJunitReport(source, content) {
  const document = xmlParser.parse(content);
  const root = document?.testsuites ?? document?.testsuite;
  if (!root) throw new Error(`${source} is not a JUnit XML report`);
  const suites = document.testsuites
    ? junitSuites(source, document.testsuites.testsuite ?? document.testsuites, document.testsuites.name)
    : junitSuites(source, document.testsuite);
  const name = String(document.testsuites?.name || basename(source));
  return buildRun(source, name, suites, {
    framework: "JUnit",
    durationMs: secondsToMilliseconds(document.testsuites?.time ?? document.testsuite?.time)
  });
}

function collectNunitSuites(source, nodes, ancestors = []) {
  const suites = [];
  for (const suite of asArray(nodes)) {
    const path = [...ancestors, String(suite?.name || "Unnamed suite")];
    const suiteName = path.join(" / ");
    const tests = [...asArray(suite?.["test-case"]), ...asArray(suite?.results?.["test-case"])].map((test) => {
      const nunit2Status = String(test?.executed).toLowerCase() === "false"
        ? "Skipped"
        : String(test?.success).toLowerCase() === "true"
          ? "Passed"
          : String(test?.success).toLowerCase() === "false"
            ? "Failed"
            : test?.success === undefined && String(test?.executed).toLowerCase() === "true"
              ? "Passed"
              : undefined;
      const status = normalizeStatus(test?.result ?? nunit2Status, test);
      const durationMs = secondsToMilliseconds(test?.duration ?? test?.time);
      const failure = test?.failure ?? {};
      const location = dotnetSourceLocation(text(failure["stack-trace"]));
      const output = annotatedOutput(source, `${suiteName}\u0000${test?.name ?? test?.fullname ?? ""}`, test?.output);
      return normalizedTest({
        source,
        suiteName,
        name: test?.name ?? test?.fullname,
        className: test?.classname,
        file: location.path,
        line: location.line,
        status,
        durationMs,
        details: {
          ...(text(failure.message) ? { errorMessage: text(failure.message) } : {}),
          ...(text(failure["stack-trace"]) ? { errorDetails: text(failure["stack-trace"]) } : {}),
          ...(test?.["start-time"] ? { startedAt: test["start-time"] } : {}),
          ...(test?.["end-time"] ? { completedAt: test["end-time"] } : {}),
          ...output
        }
      });
    });
    if (tests.length > 0) suites.push(normalizedSuite(source, suiteName, tests, { type: String(suite?.type || "TestSuite") }));
    suites.push(...collectNunitSuites(source, [...asArray(suite?.["test-suite"]), ...asArray(suite?.results?.["test-suite"])], path));
  }
  return suites;
}

export function parseNunitReport(source, content) {
  const document = xmlParser.parse(content);
  const testRun = document?.["test-run"] ?? document?.["test-results"];
  if (!testRun) throw new Error(`${source} is not an NUnit XML report`);
  const suites = collectNunitSuites(source, testRun["test-suite"]);
  return buildRun(source, String(testRun.name || basename(source)), suites, {
    framework: "NUnit",
    startedAt: testRun["start-time"],
    completedAt: testRun["end-time"],
    durationMs: secondsToMilliseconds(testRun.duration ?? testRun.time)
  });
}

export function parseTrxReport(source, content) {
  const testRun = xmlParser.parse(content)?.TestRun;
  if (!testRun) throw new Error(`${source} is not a TRX report`);
  const definitions = new Map();
  for (const definition of asArray(testRun.TestDefinitions?.UnitTest)) {
    definitions.set(String(definition.id), {
      name: definition.name,
      className: definition.TestMethod?.className,
      assemblyPath: definition.TestMethod?.codeBase
    });
  }
  const grouped = new Map();
  for (const result of asArray(testRun.Results?.UnitTestResult)) {
    const definition = definitions.get(String(result.testId)) ?? {};
    const suiteName = String(definition.className || "Unclassified");
    const tests = grouped.get(suiteName) ?? [];
    const status = normalizeStatus(result.outcome);
    const durationMs = dotnetDurationToMilliseconds(result.duration);
    const error = result.Output?.ErrorInfo ?? {};
    const location = dotnetSourceLocation(text(error.StackTrace));
    const output = annotatedOutput(
      source,
      `${suiteName}\u0000${result.testName ?? definition.name ?? ""}`,
      result.Output?.StdOut ?? testRun.ResultSummary?.Output?.StdOut,
      result.Output?.StdErr ?? testRun.ResultSummary?.Output?.StdErr,
      result.ResultFiles?.ResultFile
    );
    tests.push(normalizedTest({
      source,
      suiteName,
      name: result.testName ?? definition.name,
      className: definition.className,
      file: location.path,
      line: location.line,
      status,
      durationMs,
      details: {
        ...(text(error.Message) ? { errorMessage: text(error.Message) } : {}),
        ...(text(error.StackTrace) ? { errorDetails: text(error.StackTrace) } : {}),
        ...(result.computerName ? { computerName: String(result.computerName) } : {}),
        ...(definition.assemblyPath ? { assemblyPath: String(definition.assemblyPath).replaceAll("\\", "/") } : {}),
        ...(result.startTime ? { startedAt: result.startTime } : {}),
        ...(result.endTime ? { completedAt: result.endTime } : {}),
        ...output
      }
    }));
    grouped.set(suiteName, tests);
  }
  const suites = [...grouped].map(([name, tests]) => normalizedSuite(source, name, tests));
  const startedAt = testRun.Times?.start;
  const completedAt = testRun.Times?.finish;
  return buildRun(source, String(testRun.name || basename(source)), suites, {
    framework: "TRX",
    startedAt,
    completedAt,
    durationMs: startedAt && completedAt ? Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime()) : 0
  });
}

export function parseCtrfReport(source, content) {
  const document = JSON.parse(content);
  const results = document?.results;
  if (!Array.isArray(results?.tests)) throw new Error(`${source} is not a CTRF JSON report`);
  const grouped = new Map();
  for (const test of results.tests) {
    const suiteName = String(asArray(test.suite).filter(Boolean).join(" / ") || "Default suite");
    const tests = grouped.get(suiteName) ?? [];
    const status = normalizeStatus(test.status);
    const durationMs = Math.max(0, Math.round(finiteNumber(test.duration)));
    const output = annotatedOutput(source, `${suiteName}\u0000${test.name ?? ""}`, test.stdout, test.stderr);
    tests.push(normalizedTest({
      source,
      suiteName,
      name: test.name,
      file: test.filePath,
      status: test.flaky && status === "PASSED" ? "FLAKED" : status,
      durationMs,
      details: {
        ...(test.message ? { errorMessage: String(test.message) } : {}),
        ...(test.trace ? { errorDetails: String(test.trace) } : {}),
        ...(test.browser ? { browser: String(test.browser) } : {}),
        ...(test.device ? { device: String(test.device) } : {}),
        ...(test.platform ? { platform: String(test.platform) } : {}),
        ...output
      }
    }));
    grouped.set(suiteName, tests);
  }
  const suites = [...grouped].map(([name, tests]) => normalizedSuite(source, name, tests));
  const framework = String(results.tool?.name || "CTRF");
  return buildRun(source, String(results.environment?.appName || basename(source)), suites, {
    framework,
    durationMs: finiteNumber(results.summary?.stop) - finiteNumber(results.summary?.start),
    details: { format: "CTRF", ...(results.environment ? { environment: results.environment } : {}) }
  });
}

function playwrightStepList(source, testId, attemptNumber, steps, depth = 0) {
  return asArray(steps).flatMap((step, index) => {
    const stepId = stableId("step", source, testId, attemptNumber, depth, index, step?.title);
    const error = step?.error?.stack || step?.error?.message || "";
    return [{
      stepId,
      name: String(step?.title || "Unnamed step"),
      status: error ? "FAILED" : "PASSED",
      durationMs: Math.max(0, Math.round(finiteNumber(step?.durationMs))),
      ...(error ? { logs: [{ level: "error", message: error }] } : {}),
      details: {
        depth,
        ...(step?.category ? { category: String(step.category) } : {}),
        ...(step?.location ? { location: step.location } : {})
      }
    }, ...playwrightStepList(source, testId, attemptNumber, step?.steps, depth + 1)];
  });
}

function playwrightAttachment(source, testId, attemptNumber, attachment, index) {
  const localPath = String(attachment?.path || "").trim();
  const bodyBase64 = String(attachment?.bodyBase64 || "").trim();
  if (!localPath && !bodyBase64) return null;
  const content = localPath ? readFileSync(localPath) : Buffer.from(bodyBase64, "base64");
  const checksum = `sha256:${digest(content)}`;
  return {
    attachmentId: stableId("artifact", source, testId, attemptNumber, attachment?.name, checksum),
    name: String(attachment?.name || `attachment-${index + 1}`),
    mediaType: String(attachment?.contentType || "application/octet-stream"),
    checksum,
    sizeBytes: content.length,
    sensitivity: "INTERNAL",
    details: {
      ...(localPath ? { localPath } : {}),
      ...(bodyBase64 ? { bodyBase64 } : {})
    }
  };
}

function attachmentLog(attachment, normalizedAttachment, attemptStatus) {
  if (!normalizedAttachment || !/^(text\/|application\/(?:json|problem\+json))/.test(normalizedAttachment.mediaType)) return null;
  const details = normalizedAttachment.details ?? {};
  const content = details.localPath
    ? readFileSync(details.localPath, "utf8")
    : Buffer.from(details.bodyBase64 || "", "base64").toString("utf8");
  if (!content) return null;
  const error = attemptStatus === "FAILED" || /failure|error|stderr/i.test(normalizedAttachment.name);
  return {
    level: error ? "error" : "info",
    message: `[${normalizedAttachment.name}]\n${content.slice(0, 50000)}`
  };
}

function playwrightTestStatus(attempts) {
  const statuses = attempts.map((item) => item.status);
  const latest = statuses.at(-1) ?? "INCOMPLETE";
  if (latest === "PASSED" && statuses.slice(0, -1).some((status) => status === "FAILED" || status === "TIMED_OUT")) return "FLAKED";
  return latest;
}

export function parsePlaywrightReport(source, content) {
  const document = JSON.parse(content);
  if (document?.kind !== "passfail-playwright" || !Array.isArray(document.tests)) {
    throw new Error(`${source} is not a PassFail Playwright JSON report`);
  }
  const grouped = new Map();
  for (const test of document.tests) {
    const suiteName = [test.projectName, relative(document?.config?.rootDir || process.cwd(), test.file || "")]
      .filter(Boolean)
      .join(" / ") || "Playwright";
    const testId = stableId("test", source, test.projectName, test.testId, test.title);
    const attempts = asArray(test.attempts).map((item, index) => {
      const attemptNumber = finiteNumber(item?.attempt, index + 1);
      const status = normalizeStatus(item?.status);
      const attachmentPairs = asArray(item?.attachments)
        .map((attachment, attachmentIndex) => ({
          original: attachment,
          normalized: playwrightAttachment(source, testId, attemptNumber, attachment, attachmentIndex)
        }))
        .filter((pair) => pair.normalized);
      const attachments = attachmentPairs.map((pair) => pair.normalized);
      const errors = asArray(item?.errors).map((error) => error?.stack || error?.message || String(error)).filter(Boolean);
      const logs = [
        ...asArray(item?.stdout).map((message) => ({ level: "info", message: String(message) })),
        ...asArray(item?.stderr).map((message) => ({ level: "error", message: String(message) })),
        ...errors.map((message) => ({ level: "error", message })),
        ...attachmentPairs.map((pair) => attachmentLog(pair.original, pair.normalized, status)).filter(Boolean)
      ];
      const startedAt = item?.startedAt ? new Date(item.startedAt) : null;
      const durationMs = Math.max(0, Math.round(finiteNumber(item?.durationMs)));
      return {
        attempt: attemptNumber,
        ...(attemptNumber > 1 ? { retryOf: attemptNumber - 1 } : {}),
        status,
        ...(startedAt && !Number.isNaN(startedAt.getTime()) ? {
          startedAt: startedAt.toISOString(),
          completedAt: new Date(startedAt.getTime() + durationMs).toISOString()
        } : {}),
        steps: playwrightStepList(source, testId, attemptNumber, item?.steps),
        logs,
        attachments,
        details: {
          durationMs,
          ...(test.projectName ? { browser: String(test.projectName) } : {}),
          ...(item?.annotations?.length ? { annotations: item.annotations } : {})
        }
      };
    });
    const normalized = {
      testId,
      name: String(test.title || "Unnamed test"),
      status: playwrightTestStatus(attempts),
      attempts,
      details: {
        ...(test.projectName ? { browser: String(test.projectName) } : {}),
        ...(test.file ? { sourcePath: String(test.file).replaceAll("\\", "/") } : {}),
        ...(finiteNumber(test.line) > 0 ? { sourceLine: finiteNumber(test.line) } : {}),
        ...(finiteNumber(test.column) > 0 ? { sourceColumn: finiteNumber(test.column) } : {}),
        ...(test.expectedStatus ? { expectedStatus: String(test.expectedStatus) } : {}),
        ...(test.tags?.length ? { tags: test.tags } : {})
      }
    };
    const tests = grouped.get(suiteName) ?? [];
    tests.push(normalized);
    grouped.set(suiteName, tests);
  }
  const suites = [...grouped].map(([name, tests]) => normalizedSuite(source, name, tests, { framework: "Playwright" }));
  return buildRun(source, basename(source), suites, {
    framework: "Playwright",
    startedAt: document.startedAt,
    completedAt: document.completedAt,
    durationMs: finiteNumber(document.durationMs),
    details: { format: "Playwright JSON", toolVersion: String(document.tool?.version || "unknown") }
  });
}

export function parseTestResult(source, content, format = "auto") {
  const requested = String(format).trim().toLowerCase();
  if (requested === "playwright") return { format: "playwright", run: parsePlaywrightReport(source, content) };
  if (requested === "ctrf") return { format: "ctrf", run: parseCtrfReport(source, content) };
  if (requested === "auto" && content.trimStart().startsWith("{")) {
    const document = JSON.parse(content);
    if (document?.kind === "passfail-playwright") return { format: "playwright", run: parsePlaywrightReport(source, content) };
    return { format: "ctrf", run: parseCtrfReport(source, content) };
  }
  if (requested === "trx") return { format: "trx", run: parseTrxReport(source, content) };
  if (requested === "nunit") return { format: "nunit", run: parseNunitReport(source, content) };
  if (["junit", "xunit"].includes(requested)) return { format: "junit", run: parseJunitReport(source, content) };
  const document = xmlParser.parse(content);
  if (document?.TestRun) return { format: "trx", run: parseTrxReport(source, content) };
  if (document?.["test-run"] || document?.["test-results"]) return { format: "nunit", run: parseNunitReport(source, content) };
  if (document?.testsuites || document?.testsuite) return { format: "junit", run: parseJunitReport(source, content) };
  throw new Error(`Could not detect the test result format for ${source}`);
}

export function enrichRunWithReportEvidence(run, { reportSource, content, format }) {
  const bytes = Buffer.from(content);
  const checksum = `sha256:${digest(bytes)}`;
  const attachment = {
    attachmentId: stableId("artifact", reportSource, checksum),
    name: basename(reportSource),
    mediaType: attachmentMediaType(reportSource),
    checksum,
    sizeBytes: bytes.length,
    sensitivity: "INTERNAL",
    details: { bodyBase64: bytes.toString("base64") }
  };
  return {
    ...run,
    suites: run.suites.map((suite) => ({
      ...suite,
      tests: suite.tests.map((test) => ({
        ...test,
        attempts: test.attempts.map((item) => {
          const durationMs = Math.max(0, Math.round(finiteNumber(item.details?.durationMs ?? test.details?.durationMs)));
          const status = item.status ?? test.status ?? "INCOMPLETE";
          return {
            ...item,
            ...(item.steps?.length || item.inferredSteps?.length ? {} : {
              inferredSteps: [{
                stepId: stableId("inferred-step", reportSource, test.testId, item.attempt, status),
                name: `${run.details?.framework || format} reported ${status.toLowerCase().replaceAll("_", " ")}`,
                status: "NOT_APPLICABLE",
                durationMs,
                details: {
                  category: "report-summary",
                  confidence: "high",
                  depth: 0,
                  origin: "report-normalization",
                  parser: format,
                  sourcePath: reportSource
                }
              }]
            }),
            ...(item.logs?.length ? {} : {
              logs: [{ level: "info", message: `${run.details?.framework || format} reported "${test.name}" as ${status} in ${durationMs} ms.` }]
            }),
            ...(item.attachments?.length ? {} : { attachments: [{ ...attachment, details: { ...attachment.details } }] })
          };
        })
      }))
    }))
  };
}

function gitValue(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function booleanValue(value, fallback = false) {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

export function normalizeTestPurpose(value) {
  const purpose = String(value ?? "").trim().toLowerCase();
  if (purpose === "unit") return { caseType: "unit", gateDomain: "unit-integration", label: "Unit tests" };
  if (purpose === "integration") return { caseType: "integration", gateDomain: "unit-integration", label: "Integration tests" };
  if (["e2e", "end-to-end", "endtoend", "regression"].includes(purpose)) {
    return { caseType: "e2e", gateDomain: "regression", label: "E2E regression tests" };
  }
  throw new Error("Set PASSFAIL_TEST_PURPOSE to unit, integration, or e2e (regression is accepted as an e2e alias)");
}

function subjectFromEnvironment(environment) {
  const commitSha = environment.PASSFAIL_COMMIT_SHA?.trim() || environment.GITHUB_SHA?.trim() || gitValue(["rev-parse", "HEAD"]);
  const type = environment.PASSFAIL_SUBJECT_TYPE?.trim() || "commit";
  const provider = environment.PASSFAIL_SUBJECT_PROVIDER?.trim() || (environment.GITHUB_ACTIONS ? "github" : "git");
  const providerKey = environment.PASSFAIL_SUBJECT_KEY?.trim() || commitSha;
  if (!providerKey) throw new Error("Set PASSFAIL_SUBJECT_KEY or run the publisher in a Git repository");
  return { type, provider, providerKey };
}

async function resolveFiles(patterns) {
  const files = new Set();
  for (const pattern of patterns.split(",").map((item) => item.trim()).filter(Boolean)) {
    for await (const file of glob(pattern, { cwd: process.cwd() })) files.add(resolve(file));
  }
  return [...files].sort();
}

export function createEvidenceEnvelope({ source, content, parsed, environment = process.env }) {
  const repositoryId = environment.PASSFAIL_REPOSITORY_ID?.trim() || environment.GITHUB_REPOSITORY?.split("/").pop() || "PassFail";
  const projectId = environment.PASSFAIL_PROJECT_ID?.trim() || "passfail";
  const planRevisionId = environment.PASSFAIL_PLAN_REVISION_ID?.trim();
  if (!planRevisionId) throw new Error("Set PASSFAIL_PLAN_REVISION_ID to the exact validation plan revision used by this run");
  const purpose = normalizeTestPurpose(environment.PASSFAIL_TEST_PURPOSE);
  const sourcePath = relative(process.cwd(), source).replaceAll("\\", "/") || basename(source);
  const sourceChecksum = digest(content);
  const runIdentity = environment.GITHUB_RUN_ID?.trim() || environment.CI_PIPELINE_ID?.trim() || "local";
  const requestedUploadId = environment.PASSFAIL_UPLOAD_ID?.trim();
  const uploadId = requestedUploadId
    ? `${requestedUploadId}-${purpose.caseType}-${digest(sourcePath).slice(0, 12)}`
    : stableId("test-results", runIdentity, environment.GITHUB_RUN_ATTEMPT || "1", purpose.caseType, sourcePath, sourceChecksum);
  const enrichedRun = enrichRunWithReportEvidence(parsed.run, { reportSource: sourcePath, content, format: parsed.format });
  const framework = environment.PASSFAIL_TEST_FRAMEWORK?.trim() || enrichedRun.details.framework;
  const suites = enrichedRun.suites.map((suite) => ({
    ...suite,
    details: { ...suite.details, caseType: purpose.caseType },
    tests: suite.tests.map((test) => ({ ...test, details: { ...test.details, caseType: purpose.caseType } }))
  }));
  const run = {
    ...enrichedRun,
    suites,
    details: {
      ...parsed.run.details,
      framework,
      format: parsed.format,
      testPurpose: purpose.caseType,
      gateDomain: purpose.gateDomain,
      sourceChecksum: `sha256:${sourceChecksum}`,
      ...(environment.GITHUB_RUN_ID ? { workflowRunId: environment.GITHUB_RUN_ID } : {}),
      ...(environment.GITHUB_WORKFLOW ? { workflowName: environment.GITHUB_WORKFLOW } : {}),
      ...(environment.GITHUB_SERVER_URL && environment.GITHUB_REPOSITORY && environment.GITHUB_RUN_ID
        ? { workflowUrl: `${environment.GITHUB_SERVER_URL.replace(/\/$/, "")}/${environment.GITHUB_REPOSITORY}/actions/runs/${environment.GITHUB_RUN_ID}` }
        : {})
    }
  };
  const tests = run.suites.flatMap((suite) => suite.tests ?? []);
  const count = (status) => tests.filter((test) => test.status === status).length;
  return {
    schemaVersion: "1",
    uploadId,
    projectId,
    repositoryId,
    domain: "test",
    reporter: environment.PASSFAIL_TEST_REPORTER?.trim() || `passfail-${parsed.format}`,
    subject: subjectFromEnvironment(environment),
    planRevisionId,
    executionProfileId: environment.PASSFAIL_EXECUTION_PROFILE_ID?.trim() || "default",
    partial: booleanValue(environment.PASSFAIL_TEST_RESULTS_PARTIAL),
    sensitivity: environment.PASSFAIL_EVIDENCE_SENSITIVITY?.trim().toUpperCase() || "INTERNAL",
    report: {
      runs: [run],
      metrics: [
        { name: "tests.total", value: tests.length, unit: "count" },
        { name: "tests.passed", value: count("PASSED"), unit: "count" },
        { name: "tests.failed", value: tests.filter((test) => isFailedStatus(test.status)).length, unit: "count" },
        { name: "tests.flaked", value: count("FLAKED"), unit: "count" },
        { name: "tests.skipped", value: count("SKIPPED"), unit: "count" }
      ],
      details: {
        framework,
        format: parsed.format,
        testPurpose: purpose.caseType,
        gateDomain: purpose.gateDomain,
        sourcePath,
        sourceChecksum: `sha256:${sourceChecksum}`
      }
    }
  };
}

function testEvaluationStatus(status) {
  if (["FAILED", "TIMED_OUT", "CANCELLED", "ABORTED", "STOPPED", "INTERRUPTED"].includes(status)) return "FAILED";
  if (status === "FLAKED") return "FLAKED";
  if (status === "SKIPPED") return "SKIPPED";
  if (status === "PASSED") return "PASSED";
  return "INCOMPLETE";
}

function checkEvaluationsEndpoint(evidenceEndpoint, environment) {
  const explicit = environment.PASSFAIL_CHECK_EVALUATIONS_URL?.trim();
  if (explicit) return explicit;
  if (evidenceEndpoint === DEFAULT_ENDPOINT) return DEFAULT_CHECK_ENDPOINT;
  const endpoint = new URL(evidenceEndpoint);
  if (!endpoint.pathname.endsWith("/evidence-reports")) {
    throw new Error("Set PASSFAIL_CHECK_EVALUATIONS_URL when the evidence endpoint does not end in /evidence-reports");
  }
  endpoint.pathname = endpoint.pathname.replace(/\/evidence-reports$/, "/check-evaluations");
  return endpoint.toString();
}

function evidenceArtifactsEndpoint(evidenceEndpoint, environment) {
  const explicit = environment.PASSFAIL_EVIDENCE_ARTIFACTS_URL?.trim();
  if (explicit) return explicit;
  const endpoint = new URL(evidenceEndpoint);
  if (!endpoint.pathname.endsWith("/evidence-reports")) {
    throw new Error("Set PASSFAIL_EVIDENCE_ARTIFACTS_URL when the evidence endpoint does not end in /evidence-reports");
  }
  endpoint.pathname = endpoint.pathname.replace(/\/evidence-reports$/, "/evidence-artifacts");
  return endpoint.toString();
}

function artifactContentURL(endpoint, artifactId) {
  const url = new URL(endpoint);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${encodeURIComponent(artifactId)}/content`;
  return url.toString();
}

function evidenceAttachments(envelope) {
  return envelope.report.runs
    .flatMap((run) => [
      ...(run.attachments ?? []),
      ...run.suites.flatMap((suite) => suite.tests.flatMap((test) => test.attempts.flatMap((item) => item.attachments ?? [])))
    ]);
}

async function publishEvidenceAttachments(envelope, evidenceEndpoint, environment, fetchImpl) {
  const attachments = evidenceAttachments(envelope);
  if (attachments.length === 0) return;
  if (!booleanValue(environment.PASSFAIL_PUBLISH_TEST_ARTIFACTS, true)) {
    for (const attachment of attachments) delete attachment.details;
    return;
  }
  const endpoint = evidenceArtifactsEndpoint(evidenceEndpoint, environment);
  for (const attachment of attachments) {
    const privateDetails = attachment.details ?? {};
    const body = privateDetails.localPath
      ? readFileSync(privateDetails.localPath)
      : Buffer.from(privateDetails.bodyBase64 || "", "base64");
    attachment.attachmentId = stableId("artifact", envelope.uploadId, attachment.name, attachment.checksum);
    if (body.length === 0) {
      delete attachment.details;
      continue;
    }
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: passfailRequestHeaders(environment, {
        "content-type": "application/json",
        ...(environment.PASSFAIL_USER_ROLE ? { "x-passfail-role": environment.PASSFAIL_USER_ROLE } : {}),
        ...(environment.PASSFAIL_USER_ID ? { "x-passfail-actor": environment.PASSFAIL_USER_ID } : {})
      }),
      body: JSON.stringify({
        artifactId: attachment.attachmentId,
        projectId: envelope.projectId,
        repositoryId: envelope.repositoryId,
        kind: "EVIDENCE",
        name: attachment.name,
        mediaType: attachment.mediaType,
        checksum: attachment.checksum,
        sizeBytes: attachment.sizeBytes,
        source: {
          provider: envelope.subject.provider,
          ...(environment.GITHUB_RUN_ID ? { workflowRunId: environment.GITHUB_RUN_ID } : {}),
          ...(environment.GITHUB_RUN_ATTEMPT ? { workflowRunAttempt: finiteNumber(environment.GITHUB_RUN_ATTEMPT) } : {}),
          reporter: envelope.reporter,
          uploadId: envelope.uploadId,
          uploadIdentity: environment.GITHUB_ACTOR ? `github:${environment.GITHUB_ACTOR}` : "passfail-test-results-publisher"
        },
        subject: envelope.subject,
        sensitivity: attachment.sensitivity,
        bodyBase64: body.toString("base64"),
        createdBy: environment.GITHUB_ACTOR ? `github:${environment.GITHUB_ACTOR}` : "passfail-test-results-publisher"
      })
    });
    const artifact = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`PassFail rejected artifact ${attachment.name} (${response.status}): ${artifact.error || artifact.message || response.statusText}`);
    }
    attachment.attachmentId = artifact.artifactId || attachment.attachmentId;
    attachment.source = artifactContentURL(endpoint, attachment.attachmentId);
    delete attachment.details;
  }
}

export function createTestCheckEvaluation({ envelopes, environment = process.env }) {
  const purpose = normalizeTestPurpose(environment.PASSFAIL_TEST_PURPOSE);
  const runs = envelopes.flatMap((envelope) => envelope.report.runs);
  const tests = runs.flatMap((run) => run.suites).flatMap((suite) => suite.tests ?? []);
  const count = (status) => tests.filter((test) => test.status === status).length;
  const passed = count("PASSED");
  const failed = tests.filter((test) => isFailedStatus(test.status)).length;
  const flaked = count("FLAKED");
  const skipped = count("SKIPPED");
  const executed = tests.length - skipped;
  const passRate = executed === 0 ? 0 : Number(((passed / executed) * 100).toFixed(2));
  const status = testEvaluationStatus(aggregateStatus(tests));
  const subject = envelopes[0].subject;
  const commitSha = environment.PASSFAIL_COMMIT_SHA?.trim() || environment.GITHUB_SHA?.trim() || (subject.type === "commit" ? subject.providerKey : "");
  const reporter = [...new Set(envelopes.map((envelope) => envelope.reporter))].join(" + ");
  return {
    projectId: envelopes[0].projectId,
    repositoryId: envelopes[0].repositoryId,
    ...workflowProvenance(environment),
    subject,
    domain: purpose.gateDomain,
    name: environment.PASSFAIL_TEST_REPORT_NAME?.trim() || purpose.label,
    status,
    reporter,
    summary: `${passed}/${executed} executed tests passed; ${failed} failed, ${flaked} flaked, ${skipped} skipped`,
    environment: environment.PASSFAIL_ENVIRONMENT?.trim() || "",
    browser: environment.PASSFAIL_BROWSER?.trim() || "",
    device: environment.PASSFAIL_DEVICE?.trim() || "",
    platform: environment.PASSFAIL_PLATFORM?.trim() || "",
    branch: environment.GITHUB_HEAD_REF?.trim() || environment.GITHUB_REF_NAME?.trim() || gitValue(["branch", "--show-current"]),
    commitSha,
    metrics: {
      passRate,
      totalTests: tests.length,
      executedTests: executed,
      passedTests: passed,
      failedTests: failed,
      flakedTests: flaked,
      skippedTests: skipped
    }
  };
}

export async function publishTestResults({ environment = process.env, fetchImpl = fetch } = {}) {
  const patterns = environment.PASSFAIL_TEST_RESULT_FILES?.trim();
  if (!patterns) throw new Error("Set PASSFAIL_TEST_RESULT_FILES to one or more test result paths or globs");
  const files = await resolveFiles(patterns);
  if (files.length === 0) throw new Error(`No test result files matched ${patterns}`);
  const endpoint = environment.PASSFAIL_TEST_RESULTS_URL?.trim() || DEFAULT_ENDPOINT;
  const items = [];
  const envelopes = [];
  for (const source of files) {
    const content = await readFile(source, "utf8");
    const parsed = parseTestResult(source, content, environment.PASSFAIL_TEST_RESULTS_FORMAT || "auto");
    const envelope = createEvidenceEnvelope({ source, content, parsed, environment });
    await publishEvidenceAttachments(envelope, endpoint, environment, fetchImpl);
    envelopes.push(envelope);
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: passfailRequestHeaders(environment, { "content-type": "application/json" }),
      body: JSON.stringify(envelope)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`PassFail rejected ${source} (${response.status}): ${body.error || body.message || response.statusText}`);
    items.push(body);
  }
  let evaluation = null;
  if (booleanValue(environment.PASSFAIL_PUBLISH_CHECK_EVALUATION, true)) {
    const check = createTestCheckEvaluation({ envelopes, environment });
    const checkResponse = await fetchImpl(checkEvaluationsEndpoint(endpoint, environment), {
      method: "POST",
      headers: passfailRequestHeaders(environment, { "content-type": "application/json" }),
      body: JSON.stringify(check)
    });
    evaluation = await checkResponse.json().catch(() => ({}));
    if (!checkResponse.ok) {
      throw new Error(`PassFail rejected the ${check.domain} evaluation (${checkResponse.status}): ${evaluation.error || evaluation.message || checkResponse.statusText}`);
    }
  }
  return { items, evaluation };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  publishTestResults()
    .then(({ items, evaluation }) => console.log(`Published ${items.length} test result report${items.length === 1 ? "" : "s"}${evaluation?.checkEvaluationId ? ` and check ${evaluation.checkEvaluationId}` : ""} to PassFail`))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}