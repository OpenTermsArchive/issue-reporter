# Contributing

First of all, thanks for taking the time to contribute! 🎉👍

This module follows the same workflow and conventions as the [Open Terms Archive engine](https://github.com/OpenTermsArchive/engine/blob/main/CONTRIBUTING.md). The rules that apply to every contribution are summarised below.

## Workflow

### Pull requests

All changes are made through pull requests, which are reviewed by a maintainer before being merged. A pull request should address a single concern, be as small as possible and describe what it changes and why.

### Continuous delivery

Each pull request merged into `main` triggers a release when its changelog entry calls for one: the version is bumped according to the type of release declared in the changelog, a GitHub release is created and the package is published on npm.

### Commit messages

Commit messages are linted with [commitlint](https://commitlint.js.org):

- The header is a single sentence in sentence case, of at most 50 characters, without trailing punctuation, written in the imperative mood: `Close the issues of terms no longer declared`.
- The body, when there is one, is separated from the header by a blank line and written in sentence case.

### Changelog

All changes that impact users of this module are documented in [`CHANGELOG.md`](CHANGELOG.md), in the [Common Changelog](https://common-changelog.org) format, with the following additional specifications:

1. An `## Unreleased [<release type>]` section is added at the top of the changelog by every pull request, where the release type is one of `patch`, `minor` or `major`, as defined by [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Changes that require an adjustment in the deployment of collections are considered breaking.
2. Each listed change is a single sentence without trailing punctuation, that provides an actionable way to adapt the user’s configuration or deployment when needed.
3. The notice of the section acknowledges the sponsor of the changes, in quote format, starting with “Development of this release was supported by”, or “Development of this release was made on a volunteer basis by” for volunteer contributions.
4. The link to the source pull request is added automatically during the release process and must not be added manually.

Changes that do not add, remove or alter any behaviour, dependency, API or functionality of the module, such as changes to the README or to CI workflows, declare the following section instead, which is removed automatically after merging:

```markdown
## Unreleased [no-release]

_Modifications made in this changeset do not add, remove or alter any behavior, dependency, API or functionality of the software. They only change non-functional parts of the repository, such as the README file or CI workflows._
```

## Development

### Testing

Use `npm test` to run all tests and lint the code. Tests mock every HTTP exchange with the forges and the Collection API, so they need no network access nor credentials.

### Code style

The code is linted with [ESLint](https://eslint.org) and the configuration of the engine. Comments explain the intent of a piece of code where it is not obvious, on the same line as the code they describe when they are short.
