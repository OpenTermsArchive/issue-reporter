# Changelog

All changes that impact users of this module are documented in this file, in the [Common Changelog](https://common-changelog.org) format with some additional specifications defined in the CONTRIBUTING file. This codebase adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 1.0.1 - 2026-10-08

> Development of this release was supported by [Anthelia](https://anthelia.tech).

### Fixed

- Fix the links to the snapshots of terms combining multiple source documents, which pointed to nonexistent files

## 1.0.0 - 2026-10-08

> Development of this release was supported by the [NGI0 Commons Fund](https://nlnet.nl/project/Modular-OTA/), a fund established by [NLnet](https://nlnet.nl/) with financial support from the European Commission's [Next Generation Internet](https://www.ngi.eu) programme, under the aegis of DG CNECT under grant agreement N°101069594.

### Added

- Publish the reporter, previously part of the engine, as the standalone `@opentermsarchive/issue-reporter` package; it keeps the issues of the declarations repository on GitHub or GitLab in sync with the tracking results served by the Collection API of an engine of version 16.4.0 or later, instead of reacting to the events of the tracking process: see [how to report tracking failures](https://docs.opentermsarchive.org/collections/how-to/report-tracking-failures/) to install it in a collection
- Add the `ota-issue-reporter sync` command, synchronizing the issues with the latest completed tracking run once, or at a regular interval with the `--schedule` option
- Close the issues of terms that are no longer declared in the collection
- Report an error, sent by email when the logger is configured to do so, when no tracking run has completed for more than twice the tracking schedule interval

### Changed

- **Breaking:** Nest the configuration under the `@opentermsarchive/issue-reporter` key instead of `@opentermsarchive/engine.reporter`; move the `type`, `repositories`, `baseURL` and `apiBaseURL` entries there and add the required `collectionApi.url` entry, the legacy `githubIssues` form is no longer supported
- **Breaking:** Read the forge tokens from the `OTA_ISSUE_REPORTER_GITHUB_TOKEN` and `OTA_ISSUE_REPORTER_GITLAB_TOKEN` environment variables instead of `OTA_ENGINE_GITHUB_TOKEN` and `OTA_ENGINE_GITLAB_TOKEN`, and refuse to start without the token of the configured forge instead of silently skipping the reporting
- Mention in the issues the date of the latest change of the tracking status instead of the date of the report
- Load the issues of a GitLab project once per synchronization instead of searching them one by one
