# PassFail Automation Framework Compatibility

This repository is a machine-checkable compatibility suite for PassFail's portable test-evidence publisher.

It covers 41 Selenium combinations, 12 Playwright combinations, Cypress, Puppeteer, JavaScript browser testing, 29 Appium combinations, and six native/device integrations. The generated total is 91 framework entries.

```sh
npm install
npm run test:ci
npm run passfail:publish
```

`test:ci` generates one JUnit compatibility report per matrix entry and runs all 91 through PassFail's production parser, evidence-envelope builder, and check evaluator. This verifies ingestion, identity, status, metrics, and framework labeling.

GitHub Actions exposes the test job as the stable `PassFail Quality Gate` check. The default branch ruleset requires that exact GitHub Actions check before changes can merge.

The compatibility reports do not claim that remote or physical-device tests ran. Mobile, JavaScript browser, and Smart TV execution may require provider credentials and uploaded applications. Espresso, XCUITest, Flutter, Detox, and Maestro also require their native toolchains. Those runs should publish converted JUnit/TRX output through the same portable-report path.

Legacy entries such as Intern, Protractor, WD, Lettuce, MBUnit, PNUnit, and SpecFlow remain represented as compatibility adapters; this repository does not revive or recommend their discontinued dependencies.