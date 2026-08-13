export function flattenFrameworkMatrix(matrix) {
  const entries = [];

  for (const [language, runners] of Object.entries(matrix.webAutomation.selenium)) {
    for (const runner of runners) {
      entries.push(entry({ executionSurface: "Web automation", integration: "Selenium", language, runner, matrix }));
    }
  }

  for (const [language, runners] of Object.entries(matrix.webAutomation.playwright)) {
    for (const runner of runners) {
      entries.push(entry({ executionSurface: "Web automation", integration: "Playwright", language, runner, matrix }));
    }
  }

  for (const integration of matrix.webAutomation.topLevel.filter((name) => !["Selenium", "Playwright"].includes(name))) {
    entries.push(entry({ executionSurface: "Web automation", integration, language: "NodeJS", runner: "Generic", matrix }));
  }

  for (const [language, runners] of Object.entries(matrix.mobileAutomation.appium)) {
    for (const runner of runners) {
      entries.push(entry({ executionSurface: "Mobile automation", integration: "Appium", language, runner, matrix }));
    }
  }

  for (const integration of matrix.mobileAutomation.topLevel.filter((name) => name !== "Appium")) {
    entries.push(entry({ executionSurface: "Mobile automation", integration, language: "Native", runner: "Generic", matrix }));
  }

  return entries.sort((left, right) => left.id.localeCompare(right.id));
}

function entry({ executionSurface, integration, language, runner, matrix }) {
  const displayName = [integration, language === "Native" ? "" : language, runner === "Generic" ? "" : runner]
    .filter(Boolean)
    .join(" ");
  const legacy = matrix.legacyCompatibilityOnly.includes(runner) || matrix.legacyCompatibilityOnly.includes(integration);
  const deviceRequired = executionSurface === "Mobile automation";
  return {
    id: slug(`${executionSurface}-${integration}-${language}-${runner}`),
    executionSurface,
    integration,
    language,
    runner,
    displayName,
    reportFormat: "JUnit XML",
    supportTier: deviceRequired ? "device-execution-required" : legacy ? "legacy-compatibility" : "portable-report"
  };
}

function slug(value) {
  return value.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/^-|-$/g, "");
}
