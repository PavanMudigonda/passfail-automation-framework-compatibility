# Automation Framework Report Adapters

PassFail support begins at the test-result boundary. The selected framework and execution provider own execution; PassFail normalizes the resulting portable evidence.

The generated compatibility corpus uses JUnit XML for every entry so one deterministic format can exercise the full matrix. The table below lists the preferred production inputs, including additional formats accepted by the canonical PassFail publisher.

| Framework family | Preferred PassFail input |
| --- | --- |
| Selenium and Appium with Java, NodeJS, Python, PHP, or Ruby runners | JUnit/xUnit XML or CTRF JSON |
| Selenium, Playwright, or Appium with .NET runners | Visual Studio TRX or NUnit XML |
| Playwright Test | PassFail Playwright JSON for rich steps and artifacts, or JUnit/CTRF |
| Cypress | JUnit XML or CTRF JSON |
| Puppeteer | Node/Jest/Mocha JUnit XML or CTRF JSON |
| JavaScript browser testing | JUnit/CTRF emitted by the calling JavaScript harness |
| Espresso | Gradle Android test JUnit XML |
| XCUITest | Convert the `.xcresult` bundle to JUnit XML or CTRF before publication |
| Flutter | Convert machine-readable Flutter test output to JUnit XML before publication |
| Detox | Jest JUnit XML or CTRF JSON |
| Smart TV | JUnit output from the Appium or vendor runner used for the TV session |
| Maestro | Maestro JUnit output |

Native `.xcresult`, Flutter machine JSON, and vendor-specific device artifacts are not parsed directly. Preserve those raw files as CI artifacts, export a supported portable report, and publish the exported report with `PASSFAIL_TEST_PURPOSE=e2e`.

The compatibility suite assigns one of three support tiers:

- `portable-report`: the actively used runner can emit a supported report.
- `device-execution-required`: report ingestion is validated, but provider credentials, an uploaded application, or native tooling is required for execution.
- `legacy-compatibility`: the underlying runner is discontinued; only its portable report adapter is retained.