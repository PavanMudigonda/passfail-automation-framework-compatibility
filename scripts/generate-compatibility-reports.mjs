import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { flattenFrameworkMatrix } from "../lib/frameworks.mjs";

const matrix = JSON.parse(await readFile(new URL("../automation-framework-matrix.json", import.meta.url), "utf8"));
const entries = flattenFrameworkMatrix(matrix);
const reportsDirectory = new URL("../reports/", import.meta.url);

await rm(reportsDirectory, { recursive: true, force: true });
await mkdir(reportsDirectory, { recursive: true });

for (const framework of entries) {
  const report = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="${xml(framework.displayName)} compatibility" tests="1" failures="0" errors="0" skipped="0" time="0.001">
  <properties>
    <property name="passfail.executionSurface" value="${xml(framework.executionSurface)}" />
    <property name="passfail.integration" value="${xml(framework.integration)}" />
    <property name="passfail.language" value="${xml(framework.language)}" />
    <property name="passfail.runner" value="${xml(framework.runner)}" />
    <property name="passfail.supportTier" value="${xml(framework.supportTier)}" />
  </properties>
  <testcase classname="PassFail.Compatibility.${xml(framework.id)}" name="publishes portable execution evidence" time="0.001">
    <system-out>Compatibility validation only; device-required entries do not claim a remote or hardware execution.</system-out>
  </testcase>
</testsuite>
`;
  await writeFile(new URL(`${framework.id}.xml`, reportsDirectory), report);
}

await writeFile(
  new URL("manifest.json", reportsDirectory),
  `${JSON.stringify({ generatedAt: new Date().toISOString(), count: entries.length, entries }, null, 2)}\n`
);
console.log(`Generated ${entries.length} automation framework compatibility reports`);

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
