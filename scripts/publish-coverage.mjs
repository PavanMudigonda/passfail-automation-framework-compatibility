import { execFileSync } from "node:child_process";
import { glob, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { XMLParser } from "fast-xml-parser";

const DEFAULT_ENDPOINT = "http://localhost:30081/api/check-evaluations";

export function githubExecutionTarget(environment = process.env) {
  const eventName = environment.GITHUB_EVENT_NAME?.trim();
  const refType = environment.GITHUB_REF_TYPE?.trim();
  const refName = environment.GITHUB_REF_NAME?.trim();
  const headRef = environment.GITHUB_HEAD_REF?.trim();
  const baseBranch = environment.GITHUB_BASE_REF?.trim();
  const repository = environment.GITHUB_REPOSITORY?.trim();
  const server = environment.GITHUB_SERVER_URL?.replace(/\/$/, "");
  const pullRequestNumber = Number(environment.GITHUB_REF?.match(/^refs\/pull\/(\d+)\//)?.[1]);
  const repositoryUrl = server && repository ? `${server}/${repository}` : "";

  if (eventName?.startsWith("pull_request")) {
    return {
      type: "pull-request",
      name: headRef || refName || (pullRequestNumber ? `PR #${pullRequestNumber}` : "Pull request"),
      ...(pullRequestNumber ? { pullRequestNumber } : {}),
      ...(baseBranch ? { baseBranch } : {}),
      ...(repositoryUrl && pullRequestNumber ? { url: `${repositoryUrl}/pull/${pullRequestNumber}` } : {})
    };
  }
  if (eventName === "release") {
    return {
      type: "release",
      name: refName || "Release",
      ...(repositoryUrl && refName ? { url: `${repositoryUrl}/releases/tag/${encodeURIComponent(refName)}` } : {})
    };
  }
  if (refType === "tag") {
    return {
      type: "tag",
      name: refName || "Tag",
      ...(repositoryUrl && refName ? { url: `${repositoryUrl}/tree/${encodeURIComponent(refName)}` } : {})
    };
  }
  if (refType === "branch" || headRef || refName) {
    const name = headRef || refName;
    return {
      type: "branch",
      name,
      ...(repositoryUrl && name ? { url: `${repositoryUrl}/tree/${encodeURIComponent(name)}` } : {})
    };
  }
  const commitSha = environment.GITHUB_SHA?.trim();
  return commitSha ? {
    type: "commit",
    name: commitSha,
    ...(repositoryUrl ? { url: `${repositoryUrl}/commit/${commitSha}` } : {})
  } : undefined;
}

function percentage(covered, total) {
  return total === 0 ? 100 : Number(((covered / total) * 100).toFixed(2));
}

const coverageXmlParser = new XMLParser({
  allowBooleanAttributes: true,
  attributeNamePrefix: "",
  ignoreAttributes: false,
  parseAttributeValue: true,
  trimValues: true
});

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function reportedPercentage(value, covered, total) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Number((parsed * 100).toFixed(2)) : percentage(covered, total);
}

function normalizeCoveragePath(path) {
  return String(path ?? "").replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function repositoryCoveragePath(path, sources = []) {
  const normalized = normalizeCoveragePath(path);
  for (const source of sources.map(normalizeCoveragePath).filter(Boolean).sort((left, right) => right.length - left.length)) {
    if (normalized === source) return normalized.slice(source.length).replace(/^\/+/, "");
    if (normalized.startsWith(`${source}/`)) return normalized.slice(source.length + 1);
  }
  return normalized;
}

function languageForCoveragePath(path) {
  const extension = path.split(".").pop()?.toLowerCase();
  return ({
    adb: "Ada",
    ads: "Ada",
    asm: "Assembly",
    c: "C",
    cc: "C++",
    clj: "Clojure",
    cljs: "ClojureScript",
    cljc: "Clojure",
    cls: "Apex",
    coffee: "CoffeeScript",
    cpp: "C++",
    cr: "Crystal",
    cs: "C#",
    dart: "Dart",
    elm: "Elm",
    erl: "Erlang",
    ex: "Elixir",
    exs: "Elixir",
    f: "Fortran",
    f90: "Fortran",
    fs: "F#",
    fsx: "F#",
    go: "Go",
    groovy: "Groovy",
    h: "C/C++",
    hpp: "C++",
    hs: "Haskell",
    hrl: "Erlang",
    hx: "Haxe",
    java: "Java",
    jl: "Julia",
    js: "JavaScript",
    jsx: "JavaScript",
    kt: "Kotlin",
    kts: "Kotlin",
    lua: "Lua",
    m: "Objective-C",
    mm: "Objective-C++",
    pas: "Pascal",
    pl: "Perl",
    pm: "Perl",
    php: "PHP",
    ps1: "PowerShell",
    py: "Python",
    r: "R",
    rb: "Ruby",
    rs: "Rust",
    scala: "Scala",
    sh: "Shell",
    sol: "Solidity",
    swift: "Swift",
    trigger: "Apex",
    ts: "TypeScript",
    tsx: "TypeScript",
    vb: "Visual Basic",
    zig: "Zig",
    zsh: "Shell"
  })[extension] ?? "Other";
}

function lineDetails(lines, { number = "number", hits = "hits" } = {}) {
  const lineHits = new Map();
  for (const line of asArray(lines)) {
    const lineNumber = finiteNumber(line?.[number], -1);
    if (!Number.isInteger(lineNumber) || lineNumber < 1) continue;
    lineHits.set(lineNumber, Math.max(lineHits.get(lineNumber) ?? 0, finiteNumber(line?.[hits])));
  }
  const coveredLines = [...lineHits].filter(([, count]) => count > 0).map(([line]) => line).sort((left, right) => left - right);
  const uncoveredLines = [...lineHits].filter(([, count]) => count === 0).map(([line]) => line).sort((left, right) => left - right);
  return { coveredLines, uncoveredLines, covered: coveredLines.length, total: lineHits.size };
}

function coberturaBranchCounts(lines) {
  let covered = 0;
  let total = 0;
  for (const line of asArray(lines)) {
    const match = String(line?.["condition-coverage"] ?? "").match(/\((\d+)\s*\/\s*(\d+)\)/);
    if (!match) continue;
    covered += Number(match[1]);
    total += Number(match[2]);
  }
  return { covered, total };
}

function coberturaMethodCounts(methods) {
  let covered = 0;
  let total = 0;
  for (const method of asArray(methods)) {
    const details = lineDetails(method?.lines?.line);
    total += 1;
    if (details.covered > 0) covered += 1;
  }
  return { covered, total };
}

function mergeCoverageFile(target, source) {
  for (const line of source.coveredLines) {
    target.coveredLines.add(line);
    target.uncoveredLines.delete(line);
  }
  for (const line of source.uncoveredLines) {
    if (!target.coveredLines.has(line)) target.uncoveredLines.add(line);
  }
  target.branchCovered += source.branchCovered;
  target.branchTotal += source.branchTotal;
  target.functionCovered += source.functionCovered;
  target.functionTotal += source.functionTotal;
  target.complexity += source.complexity;
  target.branchFallback.push(source.branchCoverage);
}

function coverageFilesFromBuilders(builders) {
  return [...builders.values()].map((file) => {
    const coveredLines = [...file.coveredLines].sort((left, right) => left - right);
    const uncoveredLines = [...file.uncoveredLines].sort((left, right) => left - right);
    const lineCoverage = percentage(coveredLines.length, coveredLines.length + uncoveredLines.length);
    const fallbackBranchCoverage = file.branchFallback.length === 0
      ? 100
      : Number((file.branchFallback.reduce((sum, value) => sum + value, 0) / file.branchFallback.length).toFixed(2));
    return {
      path: file.path,
      language: languageForCoveragePath(file.path),
      statementCoverage: lineCoverage,
      lineCoverage,
      branchCoverage: file.branchTotal > 0 ? percentage(file.branchCovered, file.branchTotal) : fallbackBranchCoverage,
      ...(file.functionTotal > 0 ? { functionCoverage: percentage(file.functionCovered, file.functionTotal) } : {}),
      ...(file.complexity > 0 ? { complexity: file.complexity } : {}),
      coveredLines,
      uncoveredLines
    };
  }).sort((left, right) => left.statementCoverage - right.statementCoverage || left.path.localeCompare(right.path));
}

function coberturaPackages(coverage) {
  return asArray(coverage?.packages?.package).flatMap((item) => item ? [item] : []);
}

export function parseCoberturaCoverage(xml) {
  const coverage = coverageXmlParser.parse(xml)?.coverage;
  if (!coverage) throw new Error("Coverage report is not valid Cobertura XML");
  const sources = asArray(coverage.sources?.source).map(String);
  const builders = new Map();
  const packages = [];

  for (const packageItem of coberturaPackages(coverage)) {
    const classes = asArray(packageItem.classes?.class ?? packageItem.class);
    packages.push({
      name: String(packageItem.name || "(default)"),
      lineCoverage: reportedPercentage(packageItem["line-rate"]),
      branchCoverage: reportedPercentage(packageItem["branch-rate"]),
      complexity: finiteNumber(packageItem.complexity)
    });
    for (const classItem of classes) {
      if (!classItem?.filename) continue;
      // Coverlet emits <source>/</source> plus absolute filenames, so the working directory is the only usable root.
      const path = repositoryCoveragePath(classItem.filename, [...sources, process.cwd()]);
      const lines = asArray(classItem.lines?.line);
      const details = lineDetails(lines);
      const branches = coberturaBranchCounts(lines);
      const functions = coberturaMethodCounts(classItem.methods?.method);
      const source = {
        ...details,
        branchCovered: branches.covered,
        branchTotal: branches.total,
        branchCoverage: reportedPercentage(classItem["branch-rate"], branches.covered, branches.total),
        functionCovered: functions.covered,
        functionTotal: functions.total,
        complexity: finiteNumber(classItem.complexity)
      };
      const target = builders.get(path) ?? {
        path,
        coveredLines: new Set(),
        uncoveredLines: new Set(),
        branchCovered: 0,
        branchTotal: 0,
        functionCovered: 0,
        functionTotal: 0,
        complexity: 0,
        branchFallback: []
      };
      mergeCoverageFile(target, source);
      builders.set(path, target);
    }
  }

  const files = coverageFilesFromBuilders(builders);
  const derivedCovered = files.reduce((sum, file) => sum + file.coveredLines.length, 0);
  const derivedTotal = files.reduce((sum, file) => sum + file.coveredLines.length + file.uncoveredLines.length, 0);
  const covered = finiteNumber(coverage["lines-covered"], derivedCovered);
  const total = finiteNumber(coverage["lines-valid"], derivedTotal);
  const branchCovered = finiteNumber(coverage["branches-covered"], files.reduce((sum, file) => sum + finiteNumber(builders.get(file.path)?.branchCovered), 0));
  const branchTotal = finiteNumber(coverage["branches-valid"], files.reduce((sum, file) => sum + finiteNumber(builders.get(file.path)?.branchTotal), 0));
  const functionCovered = [...builders.values()].reduce((sum, file) => sum + file.functionCovered, 0);
  const functionTotal = [...builders.values()].reduce((sum, file) => sum + file.functionTotal, 0);
  return {
    format: "cobertura",
    reporter: "Cobertura",
    statements: { covered, total, pct: reportedPercentage(coverage["line-rate"], covered, total) },
    lines: { covered, total, pct: reportedPercentage(coverage["line-rate"], covered, total) },
    branches: { covered: branchCovered, total: branchTotal, pct: reportedPercentage(coverage["branch-rate"], branchCovered, branchTotal) },
    functions: { covered: functionCovered, total: functionTotal, pct: percentage(functionCovered, functionTotal) },
    complexity: finiteNumber(coverage.complexity, packages.reduce((sum, item) => sum + item.complexity, 0)),
    packages,
    files
  };
}

function collectJacocoPackages(node, result = []) {
  result.push(...asArray(node?.package).filter(Boolean));
  for (const group of asArray(node?.group)) collectJacocoPackages(group, result);
  return result;
}

function jacocoCounter(counters, type) {
  const counter = asArray(counters).find((item) => String(item?.type).toUpperCase() === type);
  const covered = finiteNumber(counter?.covered);
  const missed = finiteNumber(counter?.missed);
  return { covered, total: covered + missed, pct: percentage(covered, covered + missed) };
}

export function parseJacocoCoverage(xml) {
  const report = coverageXmlParser.parse(xml)?.report;
  if (!report) throw new Error("Coverage report is not valid JaCoCo XML");
  const builders = new Map();
  const packages = [];
  for (const packageItem of collectJacocoPackages(report)) {
    const packageLines = jacocoCounter(packageItem.counter, "LINE");
    const packageBranches = jacocoCounter(packageItem.counter, "BRANCH");
    const packageComplexity = jacocoCounter(packageItem.counter, "COMPLEXITY");
    packages.push({
      name: String(packageItem.name || "(default)"),
      lineCoverage: packageLines.pct,
      branchCoverage: packageBranches.pct,
      complexity: packageComplexity.total
    });
    for (const sourceFile of asArray(packageItem.sourcefile)) {
      if (!sourceFile?.name) continue;
      const path = normalizeCoveragePath([packageItem.name, sourceFile.name].filter(Boolean).join("/"));
      const lines = asArray(sourceFile.line);
      const details = lineDetails(lines, { number: "nr", hits: "ci" });
      const branches = jacocoCounter(sourceFile.counter, "BRANCH");
      const functions = jacocoCounter(sourceFile.counter, "METHOD");
      const complexity = jacocoCounter(sourceFile.counter, "COMPLEXITY");
      const target = builders.get(path) ?? {
        path,
        coveredLines: new Set(),
        uncoveredLines: new Set(),
        branchCovered: 0,
        branchTotal: 0,
        functionCovered: 0,
        functionTotal: 0,
        complexity: 0,
        branchFallback: []
      };
      mergeCoverageFile(target, {
        ...details,
        branchCovered: branches.covered,
        branchTotal: branches.total,
        branchCoverage: branches.pct,
        functionCovered: functions.covered,
        functionTotal: functions.total,
        complexity: complexity.total
      });
      builders.set(path, target);
    }
  }
  const files = coverageFilesFromBuilders(builders);
  const lineCounter = jacocoCounter(report.counter, "LINE");
  const branchCounter = jacocoCounter(report.counter, "BRANCH");
  const functionCounter = jacocoCounter(report.counter, "METHOD");
  const complexityCounter = jacocoCounter(report.counter, "COMPLEXITY");
  const derivedCovered = files.reduce((sum, file) => sum + file.coveredLines.length, 0);
  const derivedTotal = files.reduce((sum, file) => sum + file.coveredLines.length + file.uncoveredLines.length, 0);
  const lines = lineCounter.total > 0 ? lineCounter : { covered: derivedCovered, total: derivedTotal, pct: percentage(derivedCovered, derivedTotal) };
  return {
    format: "jacoco",
    reporter: "JaCoCo",
    statements: lines,
    lines,
    branches: branchCounter,
    functions: functionCounter,
    complexity: complexityCounter.total,
    packages,
    files
  };
}

function cloverMetric(metrics, coveredName, totalName) {
  const covered = finiteNumber(metrics?.[coveredName]);
  const total = finiteNumber(metrics?.[totalName]);
  return { covered, total, pct: percentage(covered, total) };
}

export function parseCloverCoverage(xml) {
  const coverage = coverageXmlParser.parse(xml)?.coverage;
  const projects = asArray(coverage?.project).filter(Boolean);
  if (projects.length === 0) throw new Error("Coverage report is not valid Clover XML");
  const builders = new Map();
  const packages = [];

  for (const project of projects) {
    const packageItems = asArray(project.package).filter(Boolean);
    for (const packageItem of packageItems) {
      const lineMetric = cloverMetric(packageItem.metrics, "coveredstatements", "statements");
      const branchMetric = cloverMetric(packageItem.metrics, "coveredconditionals", "conditionals");
      packages.push({
        name: String(packageItem.name || "(default)"),
        lineCoverage: lineMetric.pct,
        branchCoverage: branchMetric.pct,
        complexity: finiteNumber(packageItem.metrics?.complexity)
      });
    }
    const files = [
      ...asArray(project.file),
      ...packageItems.flatMap((packageItem) => asArray(packageItem.file))
    ].filter(Boolean);
    for (const fileItem of files) {
      if (!fileItem.name) continue;
      const path = repositoryCoveragePath(fileItem.name, [process.cwd()]);
      const details = lineDetails(fileItem.line, { number: "num", hits: "count" });
      const branches = cloverMetric(fileItem.metrics, "coveredconditionals", "conditionals");
      const functions = cloverMetric(fileItem.metrics, "coveredmethods", "methods");
      const target = builders.get(path) ?? {
        path,
        coveredLines: new Set(),
        uncoveredLines: new Set(),
        branchCovered: 0,
        branchTotal: 0,
        functionCovered: 0,
        functionTotal: 0,
        complexity: 0,
        branchFallback: []
      };
      mergeCoverageFile(target, {
        ...details,
        branchCovered: branches.covered,
        branchTotal: branches.total,
        branchCoverage: branches.pct,
        functionCovered: functions.covered,
        functionTotal: functions.total,
        complexity: finiteNumber(fileItem.metrics?.complexity)
      });
      builders.set(path, target);
    }
  }

  const files = coverageFilesFromBuilders(builders);
  const totals = projects.reduce((result, project) => {
    const metrics = project.metrics ?? {};
    result.lineCovered += finiteNumber(metrics.coveredstatements);
    result.lineTotal += finiteNumber(metrics.statements);
    result.branchCovered += finiteNumber(metrics.coveredconditionals);
    result.branchTotal += finiteNumber(metrics.conditionals);
    result.functionCovered += finiteNumber(metrics.coveredmethods);
    result.functionTotal += finiteNumber(metrics.methods);
    result.complexity += finiteNumber(metrics.complexity);
    return result;
  }, { lineCovered: 0, lineTotal: 0, branchCovered: 0, branchTotal: 0, functionCovered: 0, functionTotal: 0, complexity: 0 });
  if (totals.lineTotal === 0) {
    totals.lineCovered = files.reduce((sum, file) => sum + file.coveredLines.length, 0);
    totals.lineTotal = files.reduce((sum, file) => sum + file.coveredLines.length + file.uncoveredLines.length, 0);
  }
  const lines = { covered: totals.lineCovered, total: totals.lineTotal, pct: percentage(totals.lineCovered, totals.lineTotal) };
  return {
    format: "clover",
    reporter: "Clover",
    statements: lines,
    lines,
    branches: { covered: totals.branchCovered, total: totals.branchTotal, pct: percentage(totals.branchCovered, totals.branchTotal) },
    functions: { covered: totals.functionCovered, total: totals.functionTotal, pct: percentage(totals.functionCovered, totals.functionTotal) },
    complexity: totals.complexity,
    packages,
    files
  };
}

export function parseXmlCoverage(xml) {
  const document = coverageXmlParser.parse(xml);
  if (document?.coverage?.project) return parseCloverCoverage(xml);
  if (document?.coverage) return parseCoberturaCoverage(xml);
  if (document?.report) return parseJacocoCoverage(xml);
  throw new Error("Unsupported coverage XML: expected Cobertura, Clover, or JaCoCo XML");
}

function lcovCount(value) {
  if (value === undefined || value === null || value === "-") return 0;
  return finiteNumber(value);
}

export function parseLcovCoverage(report) {
  const builders = new Map();
  let current;
  const finishRecord = () => {
    if (!current?.path) return;
    const details = lineDetails([...current.lines].map(([number, hits]) => ({ number, hits })));
    const branchCovered = [...current.branches.values()].filter((hits) => hits > 0).length;
    const functionCovered = [...current.functions.values()].filter((hits) => hits > 0).length;
    const target = builders.get(current.path) ?? {
      path: current.path,
      coveredLines: new Set(),
      uncoveredLines: new Set(),
      branchCovered: 0,
      branchTotal: 0,
      functionCovered: 0,
      functionTotal: 0,
      complexity: 0,
      branchFallback: []
    };
    mergeCoverageFile(target, {
      ...details,
      branchCovered,
      branchTotal: current.branches.size,
      branchCoverage: percentage(branchCovered, current.branches.size),
      functionCovered,
      functionTotal: current.functions.size,
      complexity: 0
    });
    builders.set(current.path, target);
  };

  for (const rawLine of String(report).split(/\r?\n/)) {
    const separator = rawLine.indexOf(":");
    const key = separator < 0 ? rawLine.trim() : rawLine.slice(0, separator).trim();
    const value = separator < 0 ? "" : rawLine.slice(separator + 1).trim();
    if (key === "SF") {
      finishRecord();
      current = {
        path: repositoryCoveragePath(value, [process.cwd()]),
        lines: new Map(),
        branches: new Map(),
        functions: new Map()
      };
    } else if (key === "DA" && current) {
      const [line, hits] = value.split(",");
      const lineNumber = finiteNumber(line, -1);
      if (Number.isInteger(lineNumber) && lineNumber > 0) {
        current.lines.set(lineNumber, Math.max(current.lines.get(lineNumber) ?? 0, lcovCount(hits)));
      }
    } else if (key === "BRDA" && current) {
      const [line, block, branch, taken] = value.split(",");
      current.branches.set(`${line}:${block}:${branch}`, lcovCount(taken));
    } else if (key === "FN" && current) {
      const separatorIndex = value.indexOf(",");
      const name = separatorIndex >= 0 ? value.slice(separatorIndex + 1) : value;
      if (name) current.functions.set(name, current.functions.get(name) ?? 0);
    } else if (key === "FNDA" && current) {
      const separatorIndex = value.indexOf(",");
      const hits = separatorIndex >= 0 ? value.slice(0, separatorIndex) : "0";
      const name = separatorIndex >= 0 ? value.slice(separatorIndex + 1) : value;
      if (name) current.functions.set(name, Math.max(current.functions.get(name) ?? 0, lcovCount(hits)));
    } else if (key === "end_of_record") {
      finishRecord();
      current = undefined;
    }
  }
  finishRecord();

  if (builders.size === 0) throw new Error("Coverage report is not valid LCOV");
  const files = coverageFilesFromBuilders(builders);
  const metric = (coveredName, totalName) => {
    const covered = [...builders.values()].reduce((sum, file) => sum + file[coveredName], 0);
    const total = [...builders.values()].reduce((sum, file) => sum + file[totalName], 0);
    return { covered, total, pct: percentage(covered, total) };
  };
  const lines = {
    covered: files.reduce((sum, file) => sum + file.coveredLines.length, 0),
    total: files.reduce((sum, file) => sum + file.coveredLines.length + file.uncoveredLines.length, 0)
  };
  lines.pct = percentage(lines.covered, lines.total);
  return {
    format: "lcov",
    reporter: "LCOV",
    statements: lines,
    lines,
    branches: metric("branchCovered", "branchTotal"),
    functions: metric("functionCovered", "functionTotal"),
    complexity: 0,
    packages: [],
    files
  };
}

function normalizedFileCoverage({ path, coveredLines, uncoveredLines, branchCovered = 0, branchTotal = 0, functionCovered = 0, functionTotal = 0, statementCovered, statementTotal }) {
  const lineCoverage = percentage(coveredLines.length, coveredLines.length + uncoveredLines.length);
  return {
    path: repositoryCoveragePath(path, [process.cwd()]),
    language: languageForCoveragePath(path),
    statementCoverage: statementTotal > 0 ? percentage(statementCovered, statementTotal) : lineCoverage,
    lineCoverage,
    ...(branchTotal > 0 ? { branchCoverage: percentage(branchCovered, branchTotal) } : {}),
    ...(functionTotal > 0 ? { functionCoverage: percentage(functionCovered, functionTotal) } : {}),
    coveredLines,
    uncoveredLines
  };
}

function reportMetric(files, coveredName, totalName) {
  const covered = files.reduce((sum, file) => sum + finiteNumber(file[coveredName]), 0);
  const total = files.reduce((sum, file) => sum + finiteNumber(file[totalName]), 0);
  return { covered, total, pct: percentage(covered, total) };
}

export function parseIstanbulCoverage(document) {
  const entries = Object.entries(document ?? {}).filter(([, file]) => file?.statementMap && file?.s);
  if (entries.length === 0) throw new Error("Coverage report is not valid Istanbul JSON");
  const parsedFiles = entries.map(([reportedPath, source]) => {
    const lineHits = new Map();
    for (const [statementId, hits] of Object.entries(source.s ?? {})) {
      const line = source.statementMap?.[statementId]?.start?.line;
      if (Number.isInteger(line)) lineHits.set(line, Math.max(lineHits.get(line) ?? 0, finiteNumber(hits)));
    }
    const coveredLines = [...lineHits].filter(([, hits]) => hits > 0).map(([line]) => line).sort((left, right) => left - right);
    const uncoveredLines = [...lineHits].filter(([, hits]) => hits === 0).map(([line]) => line).sort((left, right) => left - right);
    const branchHits = Object.values(source.b ?? {}).flatMap((hits) => asArray(hits).map(finiteNumber));
    const functionHits = Object.values(source.f ?? {}).map(finiteNumber);
    const statementHits = Object.values(source.s ?? {}).map(finiteNumber);
    return {
      file: normalizedFileCoverage({
        path: source.path || reportedPath,
        coveredLines,
        uncoveredLines,
        branchCovered: branchHits.filter((hits) => hits > 0).length,
        branchTotal: branchHits.length,
        functionCovered: functionHits.filter((hits) => hits > 0).length,
        functionTotal: functionHits.length,
        statementCovered: statementHits.filter((hits) => hits > 0).length,
        statementTotal: statementHits.length
      }),
      lineCovered: coveredLines.length,
      lineTotal: lineHits.size,
      branchCovered: branchHits.filter((hits) => hits > 0).length,
      branchTotal: branchHits.length,
      functionCovered: functionHits.filter((hits) => hits > 0).length,
      functionTotal: functionHits.length,
      statementCovered: statementHits.filter((hits) => hits > 0).length,
      statementTotal: statementHits.length
    };
  });
  return {
    format: "istanbul",
    reporter: "Istanbul/c8",
    statements: reportMetric(parsedFiles, "statementCovered", "statementTotal"),
    lines: reportMetric(parsedFiles, "lineCovered", "lineTotal"),
    branches: reportMetric(parsedFiles, "branchCovered", "branchTotal"),
    functions: reportMetric(parsedFiles, "functionCovered", "functionTotal"),
    complexity: 0,
    packages: [],
    files: parsedFiles.map((item) => item.file)
  };
}

export function parseCoveragePyJson(document) {
  const entries = Object.entries(document?.files ?? {});
  if (entries.length === 0) throw new Error("Coverage report is not valid coverage.py JSON");
  const parsedFiles = entries.map(([path, source]) => {
    const coveredLines = [...new Set(asArray(source.executed_lines).map(Number).filter(Number.isInteger))].sort((left, right) => left - right);
    const uncoveredLines = [...new Set(asArray(source.missing_lines).map(Number).filter(Number.isInteger))].sort((left, right) => left - right);
    const summary = source.summary ?? {};
    const lineCovered = finiteNumber(summary.covered_lines, coveredLines.length);
    const lineTotal = finiteNumber(summary.num_statements, coveredLines.length + uncoveredLines.length);
    const branchCovered = finiteNumber(summary.covered_branches, asArray(source.executed_branches).length);
    const branchTotal = finiteNumber(summary.num_branches, branchCovered + asArray(source.missing_branches).length);
    const functionTotal = finiteNumber(summary.num_functions);
    const functionCovered = finiteNumber(summary.covered_functions);
    return {
      file: normalizedFileCoverage({ path, coveredLines, uncoveredLines, branchCovered, branchTotal, functionCovered, functionTotal, statementCovered: lineCovered, statementTotal: lineTotal }),
      lineCovered,
      lineTotal,
      branchCovered,
      branchTotal,
      functionCovered,
      functionTotal
    };
  });
  const totals = document.totals ?? {};
  const metric = (coveredName, totalName, fallback) => {
    const total = finiteNumber(totals[totalName], fallback.total);
    const covered = finiteNumber(totals[coveredName], fallback.covered);
    return { covered, total, pct: percentage(covered, total) };
  };
  const lines = metric("covered_lines", "num_statements", reportMetric(parsedFiles, "lineCovered", "lineTotal"));
  return {
    format: "coverage.py",
    reporter: "coverage.py",
    statements: lines,
    lines,
    branches: metric("covered_branches", "num_branches", reportMetric(parsedFiles, "branchCovered", "branchTotal")),
    functions: metric("covered_functions", "num_functions", reportMetric(parsedFiles, "functionCovered", "functionTotal")),
    complexity: 0,
    packages: [],
    files: parsedFiles.map((item) => item.file)
  };
}

export function parseCoverallsCoverage(document) {
  const sourceFiles = asArray(document?.source_files).filter((file) => file?.name && Array.isArray(file.coverage));
  if (sourceFiles.length === 0) throw new Error("Coverage report is not valid Coveralls JSON");
  const parsedFiles = sourceFiles.map((source) => {
    const coveredLines = [];
    const uncoveredLines = [];
    source.coverage.forEach((hits, index) => {
      if (hits === null || hits === undefined) return;
      (finiteNumber(hits) > 0 ? coveredLines : uncoveredLines).push(index + 1);
    });
    const rawBranches = asArray(source.branches);
    const branchHits = [];
    for (let index = 3; index < rawBranches.length; index += 4) branchHits.push(lcovCount(rawBranches[index]));
    return {
      file: normalizedFileCoverage({
        path: source.name,
        coveredLines,
        uncoveredLines,
        branchCovered: branchHits.filter((hits) => hits > 0).length,
        branchTotal: branchHits.length,
        statementCovered: coveredLines.length,
        statementTotal: coveredLines.length + uncoveredLines.length
      }),
      lineCovered: coveredLines.length,
      lineTotal: coveredLines.length + uncoveredLines.length,
      branchCovered: branchHits.filter((hits) => hits > 0).length,
      branchTotal: branchHits.length
    };
  });
  const lines = reportMetric(parsedFiles, "lineCovered", "lineTotal");
  return {
    format: "coveralls",
    reporter: "Coveralls JSON",
    statements: lines,
    lines,
    branches: reportMetric(parsedFiles, "branchCovered", "branchTotal"),
    functions: { covered: 0, total: 0, pct: 100 },
    complexity: 0,
    packages: [],
    files: parsedFiles.map((item) => item.file)
  };
}

export function parseJsonCoverage(json) {
  let document;
  try {
    document = typeof json === "string" ? JSON.parse(json) : json;
  } catch {
    throw new Error("Coverage report is not valid JSON");
  }
  if (document?.source_files) return parseCoverallsCoverage(document);
  if (document?.meta && document?.files) return parseCoveragePyJson(document);
  return parseIstanbulCoverage(document);
}

export function parseGoCoverageReport(profile, options = {}) {
  const parsed = parseGoCoverage(profile, options);
  const files = parsed.files.map((file) => ({
    ...file,
    lineCoverage: percentage(file.coveredLines.length, file.coveredLines.length + file.uncoveredLines.length)
  }));
  const lineCovered = files.reduce((sum, file) => sum + file.coveredLines.length, 0);
  const lineTotal = files.reduce((sum, file) => sum + file.coveredLines.length + file.uncoveredLines.length, 0);
  return {
    format: "go-cover",
    reporter: "Go cover",
    statements: { covered: parsed.covered, total: parsed.total, pct: parsed.pct },
    lines: { covered: lineCovered, total: lineTotal, pct: percentage(lineCovered, lineTotal) },
    branches: { covered: 0, total: 0, pct: 100 },
    functions: { covered: 0, total: 0, pct: 100 },
    complexity: 0,
    packages: [],
    files
  };
}

export function parseGcovCoverage(report) {
  const files = [];
  let current;
  const gcovCount = (value) => String(value).trim().toLowerCase() === "taken" ? 1 : lcovCount(value);
  const finishFile = () => {
    if (!current?.path) return;
    const coveredLines = [...current.lines].filter(([, hits]) => hits > 0).map(([line]) => line).sort((left, right) => left - right);
    const uncoveredLines = [...current.lines].filter(([, hits]) => hits === 0).map(([line]) => line).sort((left, right) => left - right);
    files.push({
      file: normalizedFileCoverage({
        path: current.path,
        coveredLines,
        uncoveredLines,
        branchCovered: current.branches.filter((hits) => hits > 0).length,
        branchTotal: current.branches.length,
        functionCovered: current.functions.filter((hits) => hits > 0).length,
        functionTotal: current.functions.length,
        statementCovered: coveredLines.length,
        statementTotal: coveredLines.length + uncoveredLines.length
      }),
      lineCovered: coveredLines.length,
      lineTotal: coveredLines.length + uncoveredLines.length,
      branchCovered: current.branches.filter((hits) => hits > 0).length,
      branchTotal: current.branches.length,
      functionCovered: current.functions.filter((hits) => hits > 0).length,
      functionTotal: current.functions.length
    });
  };
  for (const rawLine of String(report).split(/\r?\n/)) {
    const separator = rawLine.indexOf(":");
    if (separator < 0) continue;
    const key = rawLine.slice(0, separator).trim();
    const value = rawLine.slice(separator + 1).trim();
    if (key === "file") {
      finishFile();
      current = { path: value, lines: new Map(), branches: [], functions: [] };
    } else if (key === "lcount" && current) {
      const [line, hits] = value.split(",");
      current.lines.set(finiteNumber(line), lcovCount(hits));
    } else if (key === "branch" && current) {
      current.branches.push(gcovCount(value.split(",")[1]));
    } else if (key === "function" && current) {
      const parts = value.split(",");
      current.functions.push(lcovCount(parts.length >= 4 ? parts[2] : parts[1]));
    }
  }
  finishFile();
  if (files.length === 0) throw new Error("Coverage report is not valid gcov intermediate text");
  const lines = reportMetric(files, "lineCovered", "lineTotal");
  return {
    format: "gcov",
    reporter: "gcov",
    statements: lines,
    lines,
    branches: reportMetric(files, "branchCovered", "branchTotal"),
    functions: reportMetric(files, "functionCovered", "functionTotal"),
    complexity: 0,
    packages: [],
    files: files.map((item) => item.file)
  };
}

export function parseCoverageReport(content, options = {}) {
  const trimmed = String(content).trim();
  if (trimmed.startsWith("<") || trimmed.startsWith("<?xml")) return parseXmlCoverage(trimmed);
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return parseJsonCoverage(trimmed);
  if (/^(?:TN:.*\n)?SF:/m.test(trimmed)) return parseLcovCoverage(trimmed);
  if (/^mode:\s*(?:set|count|atomic)$/m.test(trimmed)) return parseGoCoverageReport(trimmed, options);
  if (/^file:/m.test(trimmed) && /^lcount:/m.test(trimmed)) return parseGcovCoverage(trimmed);
  throw new Error("Unsupported coverage report: expected Codecov-compatible XML, JSON, or text coverage");
}

export function workflowProvenance(environment = process.env) {
  const workflowRunId = environment.GITHUB_RUN_ID?.trim();
  if (!workflowRunId) return {};
  const repository = environment.GITHUB_REPOSITORY?.trim();
  const server = environment.GITHUB_SERVER_URL?.replace(/\/$/, "");
  const target = githubExecutionTarget(environment);
  const workflowRefValue = environment.GITHUB_WORKFLOW_REF?.trim() ?? "";
  const workflowMarker = "/.github/workflows/";
  const workflowMarkerIndex = workflowRefValue.indexOf(workflowMarker);
  const workflowRefSeparator = workflowRefValue.lastIndexOf("@");
  const workflowPath = workflowMarkerIndex >= 0
    ? workflowRefValue.slice(workflowMarkerIndex + 1, workflowRefSeparator > workflowMarkerIndex ? workflowRefSeparator : undefined)
    : "";
  const workflowRef = workflowRefSeparator > workflowMarkerIndex
    ? workflowRefValue.slice(workflowRefSeparator + 1)
    : "";
  const workflowRunAttempt = Number(environment.GITHUB_RUN_ATTEMPT);
  const workflowRunNumber = Number(environment.GITHUB_RUN_NUMBER);
  return {
    workflowRunId,
    ...(environment.GITHUB_WORKFLOW_ID?.trim() ? { workflowId: environment.GITHUB_WORKFLOW_ID.trim() } : {}),
    ...(workflowPath ? { workflowPath } : {}),
    ...(workflowRef ? { workflowRef } : {}),
    ...(environment.GITHUB_WORKFLOW_SHA?.trim() ? { workflowSha: environment.GITHUB_WORKFLOW_SHA.trim() } : {}),
    ...(Number.isInteger(workflowRunAttempt) && workflowRunAttempt > 0 ? { workflowRunAttempt } : {}),
    ...(Number.isInteger(workflowRunNumber) && workflowRunNumber > 0 ? { workflowRunNumber } : {}),
    workflowName: environment.GITHUB_WORKFLOW?.trim() || "GitHub Actions",
    ...(environment.GITHUB_EVENT_NAME?.trim() ? { workflowEvent: environment.GITHUB_EVENT_NAME.trim() } : {}),
    ...(target ? { target } : {}),
    ...(server && repository ? { workflowUrl: `${server}/${repository}/actions/runs/${workflowRunId}` } : {})
  };
}

export function parseGoCoverage(profile, { goModule } = {}) {
  let covered = 0;
  let total = 0;
  const goModulePrefix = String(goModule ?? "").trim().replace(/\/+$/, "");
  const fileTotals = new Map();
  for (const line of profile.trim().split("\n").slice(1)) {
    const match = line.match(/^(.+):(\d+)\.\d+,\d+\.\d+\s+(\d+)\s+(\d+)$/);
    if (!match) continue;
    let path = match[1].replace("passfail.dev/ingestion-projection/", "services/ingestion-projection/");
    if (goModulePrefix && (path === goModulePrefix || path.startsWith(`${goModulePrefix}/`))) {
      path = path.slice(goModulePrefix.length).replace(/^\/+/, "");
    }
    const startLine = Number(match[2]);
    const statements = Number(match[3]);
    const count = Number(match[4]);
    total += statements;
    if (count > 0) covered += statements;
    const file = fileTotals.get(path) ?? { covered: 0, total: 0, coveredLines: new Set(), uncoveredLines: new Set() };
    file.total += statements;
    if (count > 0) {
      file.covered += statements;
      file.coveredLines.add(startLine);
    }
    else file.uncoveredLines.add(startLine);
    fileTotals.set(path, file);
  }
  const files = [...fileTotals.entries()].map(([path, file]) => ({
    path,
    language: "Go",
    statementCoverage: percentage(file.covered, file.total),
    coveredLines: [...file.coveredLines].sort((left, right) => left - right),
    uncoveredLines: [...file.uncoveredLines].sort((left, right) => left - right)
  }));
  return { covered, total, pct: percentage(covered, total), files };
}

export function parseFrontendCoverage(summary, detailed = {}) {
  const total = summary.total;
  if (!total?.statements || !total?.lines || !total?.branches || !total?.functions) {
    throw new Error("Frontend coverage summary is missing total metrics");
  }
  return {
    statements: total.statements,
    lines: total.lines,
    branches: total.branches,
    functions: total.functions,
    files: Object.entries(summary)
      .filter(([path]) => path !== "total")
      .map(([path, metrics]) => {
        const source = detailed[path];
        const lineHits = new Map();
        for (const [statementId, hits] of Object.entries(source?.s ?? {})) {
          const line = source.statementMap[statementId]?.start?.line;
          if (Number.isInteger(line)) lineHits.set(line, Math.max(lineHits.get(line) ?? 0, hits));
        }
        const coveredLines = [...lineHits].filter(([, hits]) => hits > 0).map(([line]) => line).sort((left, right) => left - right);
        const uncoveredLines = [...lineHits].filter(([, hits]) => hits === 0).map(([line]) => line).sort((left, right) => left - right);
        const workspaceMarker = "/PassFail/";
        const markerIndex = path.lastIndexOf(workspaceMarker);
        return {
          path: markerIndex >= 0 ? path.slice(markerIndex + workspaceMarker.length) : path,
          language: "TypeScript",
          statementCoverage: metrics.statements.pct,
          lineCoverage: metrics.lines.pct,
          branchCoverage: metrics.branches.pct,
          functionCoverage: metrics.functions.pct,
          coveredLines,
          uncoveredLines
        };
      })
  };
}

export function parseUnifiedDiff(diff) {
  const changedLines = new Map();
  let path = "";
  let newLine = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      path = target === "/dev/null" ? "" : target.replace(/^b\//, "");
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (!path || line.startsWith("diff --git") || line.startsWith("--- ") || line.startsWith("\\")) continue;
    if (line.startsWith("+")) {
      const lines = changedLines.get(path) ?? new Set();
      lines.add(newLine);
      changedLines.set(path, lines);
      newLine += 1;
    } else if (!line.startsWith("-")) {
      newLine += 1;
    }
  }
  return changedLines;
}

export function calculateChangedCoverage(files, changedLines) {
  let covered = 0;
  let total = 0;
  for (const file of files) {
    const changed = changedLines.get(file.path);
    if (!changed) continue;
    const coveredLines = new Set(file.coveredLines ?? []);
    const executableLines = new Set([...coveredLines, ...(file.uncoveredLines ?? [])]);
    for (const line of executableLines) {
      if (!changed.has(line)) continue;
      total += 1;
      if (coveredLines.has(line)) covered += 1;
    }
  }
  return { covered, total, pct: percentage(covered, total) };
}

export function createChangedCoverageEvaluation({ coverage, baselineCommitSha, reporter = "normalized coverage", environment = process.env, git = {} }) {
  const threshold = Number(environment.PASSFAIL_CHANGED_COVERAGE_THRESHOLD ?? environment.PASSFAIL_COVERAGE_THRESHOLD ?? 80);
  return {
    projectId: environment.PASSFAIL_PROJECT_ID ?? "passfail",
    repositoryId: environment.PASSFAIL_REPOSITORY_ID ?? "PassFail",
    ...workflowProvenance(environment),
    domain: "changed-coverage",
    name: "Changed-line code coverage",
    status: coverage.pct >= threshold ? "PASSED" : "FAILED",
    reporter: `git-diff + ${reporter}`,
    environment: environment.PASSFAIL_ENVIRONMENT ?? "Local",
    branch: environment.GITHUB_REF_NAME ?? git.branch ?? "",
    commitSha: environment.GITHUB_SHA ?? git.commitSha ?? "",
    baselineCommitSha,
    summary: `${coverage.covered} of ${coverage.total} changed executable lines covered (${coverage.pct.toFixed(2)}%; threshold ${threshold.toFixed(2)}%)`,
    metrics: {
      changedLineCoverage: coverage.pct,
      changedExecutableLines: coverage.total,
      changedCoveredLines: coverage.covered,
      changedCoverageThreshold: threshold
    }
  };
}

export function createEvaluation({ frontend, go, environment = process.env, git = {} }) {
  const frontendStatements = frontend.statements;
  const combinedCovered = frontendStatements.covered + go.covered;
  const combinedTotal = frontendStatements.total + go.total;
  const combinedCoverage = percentage(combinedCovered, combinedTotal);
  const threshold = Number(environment.PASSFAIL_COVERAGE_THRESHOLD ?? 80);

  return {
    projectId: environment.PASSFAIL_PROJECT_ID ?? "passfail",
    repositoryId: environment.PASSFAIL_REPOSITORY_ID ?? "PassFail",
    ...workflowProvenance(environment),
    domain: "coverage",
    name: "Repository code coverage",
    status: combinedCoverage >= threshold ? "PASSED" : "FAILED",
    reporter: "go-cover + vitest-v8",
    environment: environment.PASSFAIL_ENVIRONMENT ?? "Local",
    branch: environment.GITHUB_REF_NAME ?? git.branch ?? "",
    commitSha: environment.GITHUB_SHA ?? git.commitSha ?? "",
    summary: `Go statements ${go.pct.toFixed(2)}%; TypeScript statements ${frontendStatements.pct.toFixed(2)}%; combined ${combinedCoverage.toFixed(2)}% (threshold ${threshold.toFixed(2)}%)`,
    metrics: {
      lineCoverage: combinedCoverage,
      statementCoverage: combinedCoverage,
      goStatementCoverage: go.pct,
      typescriptStatementCoverage: frontendStatements.pct,
      typescriptLineCoverage: frontend.lines.pct,
      typescriptBranchCoverage: frontend.branches.pct,
      typescriptFunctionCoverage: frontend.functions.pct,
      coverageThreshold: threshold
    },
    coverageFiles: [...go.files, ...frontend.files].sort((left, right) => left.statementCoverage - right.statementCoverage || left.path.localeCompare(right.path))
  };
}

function aggregateCoverageFiles(reports) {
  const builders = new Map();
  for (const file of reports.flatMap((report) => report.files)) {
    const key = `${file.language}\0${file.path}`;
    const target = builders.get(key) ?? {
      path: file.path,
      language: file.language,
      coveredLines: new Set(),
      uncoveredLines: new Set(),
      branchTotal: 0,
      branchWeighted: 0,
      functionTotal: 0,
      functionWeighted: 0,
      complexity: 0
    };
    for (const line of file.coveredLines ?? []) {
      target.coveredLines.add(line);
      target.uncoveredLines.delete(line);
    }
    for (const line of file.uncoveredLines ?? []) {
      if (!target.coveredLines.has(line)) target.uncoveredLines.add(line);
    }
    const executableLines = (file.coveredLines?.length ?? 0) + (file.uncoveredLines?.length ?? 0) || 1;
    if (Number.isFinite(file.branchCoverage)) {
      target.branchTotal += executableLines;
      target.branchWeighted += file.branchCoverage * executableLines;
    }
    if (Number.isFinite(file.functionCoverage)) {
      target.functionTotal += executableLines;
      target.functionWeighted += file.functionCoverage * executableLines;
    }
    target.complexity += finiteNumber(file.complexity);
    builders.set(key, target);
  }
  return [...builders.values()].map((file) => {
    const coveredLines = [...file.coveredLines].sort((left, right) => left - right);
    const uncoveredLines = [...file.uncoveredLines].sort((left, right) => left - right);
    const lineCoverage = percentage(coveredLines.length, coveredLines.length + uncoveredLines.length);
    return {
      path: file.path,
      language: file.language,
      statementCoverage: lineCoverage,
      lineCoverage,
      ...(file.branchTotal > 0 ? { branchCoverage: Number((file.branchWeighted / file.branchTotal).toFixed(2)) } : {}),
      ...(file.functionTotal > 0 ? { functionCoverage: Number((file.functionWeighted / file.functionTotal).toFixed(2)) } : {}),
      ...(file.complexity > 0 ? { complexity: file.complexity } : {}),
      coveredLines,
      uncoveredLines
    };
  }).sort((left, right) => left.statementCoverage - right.statementCoverage || left.path.localeCompare(right.path));
}

function aggregateCoveragePackages(reports) {
  const packages = new Map();
  for (const item of reports.flatMap((report) => report.packages)) {
    const target = packages.get(item.name) ?? { name: item.name, count: 0, lineCoverage: 0, branchCoverage: 0, complexity: 0 };
    target.count += 1;
    target.lineCoverage += finiteNumber(item.lineCoverage);
    target.branchCoverage += finiteNumber(item.branchCoverage);
    target.complexity += finiteNumber(item.complexity);
    packages.set(item.name, target);
  }
  return [...packages.values()].map((item) => ({
    name: item.name,
    lineCoverage: Number((item.lineCoverage / item.count).toFixed(2)),
    branchCoverage: Number((item.branchCoverage / item.count).toFixed(2)),
    complexity: item.complexity
  })).sort((left, right) => left.lineCoverage - right.lineCoverage || left.name.localeCompare(right.name));
}

export function createCoverageEvaluation({ reports, environment = process.env, git = {} }) {
  if (!Array.isArray(reports) || reports.length === 0) throw new Error("At least one coverage report is required");
  const totalMetric = (name) => {
    const covered = reports.reduce((sum, report) => sum + finiteNumber(report[name]?.covered), 0);
    const total = reports.reduce((sum, report) => sum + finiteNumber(report[name]?.total), 0);
    return { covered, total, pct: percentage(covered, total) };
  };
  const lines = totalMetric("lines");
  const branches = totalMetric("branches");
  const functions = totalMetric("functions");
  const threshold = finiteNumber(environment.PASSFAIL_COVERAGE_THRESHOLD, 80);
  const reporter = [...new Set(reports.map((report) => report.reporter))].join(" + ");
  return {
    projectId: environment.PASSFAIL_PROJECT_ID ?? "passfail",
    repositoryId: environment.PASSFAIL_REPOSITORY_ID ?? "PassFail",
    ...workflowProvenance(environment),
    domain: "coverage",
    name: environment.PASSFAIL_COVERAGE_REPORT_NAME?.trim() || "Repository code coverage",
    status: lines.pct >= threshold ? "PASSED" : "FAILED",
    reporter,
    environment: environment.PASSFAIL_ENVIRONMENT ?? "Local",
    branch: environment.GITHUB_REF_NAME ?? git.branch ?? "",
    commitSha: environment.GITHUB_SHA ?? git.commitSha ?? "",
    summary: `Lines ${lines.pct.toFixed(2)}% (${lines.covered}/${lines.total}); branches ${branches.total > 0 ? `${branches.pct.toFixed(2)}%` : "not reported"}; functions ${functions.total > 0 ? `${functions.pct.toFixed(2)}%` : "not reported"}; threshold ${threshold.toFixed(2)}%`,
    metrics: {
      statementCoverage: lines.pct,
      lineCoverage: lines.pct,
      branchCoverage: branches.pct,
      functionCoverage: functions.pct,
      coverageThreshold: threshold,
      coveredLines: lines.covered,
      missedLines: lines.total - lines.covered,
      totalLines: lines.total,
      coveredBranches: branches.covered,
      missedBranches: branches.total - branches.covered,
      totalBranches: branches.total,
      coveredFunctions: functions.covered,
      missedFunctions: functions.total - functions.covered,
      totalFunctions: functions.total,
      complexity: reports.reduce((sum, report) => sum + finiteNumber(report.complexity), 0)
    },
    coveragePackages: aggregateCoveragePackages(reports),
    coverageFiles: aggregateCoverageFiles(reports)
  };
}

export const createXmlCoverageEvaluation = createCoverageEvaluation;

export async function resolveCoverageReportPaths(value) {
  const patterns = String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  const paths = new Set();
  for (const pattern of patterns) {
    for await (const path of glob(pattern)) paths.add(path);
  }
  if (paths.size === 0) throw new Error(`No coverage files matched: ${patterns.join(", ") || "(empty input)"}`);
  return [...paths].sort();
}

function gitValue(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

async function readGoModulePath() {
  try {
    const match = (await readFile("go.mod", "utf8")).match(/^\s*module\s+(\S+)/m);
    return match ? match[1] : "";
  } catch {
    return "";
  }
}

export async function publishCoverage({ environment = process.env, fetchImpl = fetch } = {}) {
  const git = {
    branch: gitValue(["branch", "--show-current"]),
    commitSha: gitValue(["rev-parse", "HEAD"])
  };
  let evaluation;
  if (environment.PASSFAIL_COVERAGE_FILES?.trim()) {
    const paths = await resolveCoverageReportPaths(environment.PASSFAIL_COVERAGE_FILES);
    const goModule = environment.PASSFAIL_GO_MODULE?.trim() || (await readGoModulePath());
    const reports = await Promise.all(paths.map(async (path) => parseCoverageReport(await readFile(path, "utf8"), { goModule })));
    evaluation = createCoverageEvaluation({ reports, environment, git });
  } else {
    const [frontendRaw, frontendDetailedRaw, goProfile] = await Promise.all([
      readFile("services/web-ui/coverage/coverage-summary.json", "utf8"),
      readFile("services/web-ui/coverage/coverage-final.json", "utf8"),
      readFile("coverage/ingestion-projection.out", "utf8")
    ]);
    evaluation = createEvaluation({
      frontend: parseFrontendCoverage(JSON.parse(frontendRaw), JSON.parse(frontendDetailedRaw)),
      go: parseGoCoverage(goProfile),
      environment,
      git
    });
  }
  const evaluations = [evaluation];
  const baselineCommitSha = environment.PASSFAIL_BASELINE_SHA?.trim();
  if (baselineCommitSha) {
    const diff = gitValue(["-c", "core.quotepath=false", "diff", "--unified=0", baselineCommitSha, "HEAD", "--"]);
    evaluations.push(createChangedCoverageEvaluation({
      coverage: calculateChangedCoverage(evaluation.coverageFiles, parseUnifiedDiff(diff)),
      baselineCommitSha,
      reporter: evaluation.reporter,
      environment,
      git
    }));
  }
  const endpoint = environment.PASSFAIL_COVERAGE_URL ?? DEFAULT_ENDPOINT;
  const published = [];
  for (const item of evaluations) {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(item)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`PassFail coverage upload failed (${response.status}): ${body.message ?? body.error ?? "unknown error"}`);
    }
    published.push(body);
  }
  return { items: published };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  publishCoverage()
    .then((result) => console.log(`Published ${result.items.length} coverage evaluation(s): ${result.items.map((item) => item.checkEvaluationId).join(", ")}`))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}