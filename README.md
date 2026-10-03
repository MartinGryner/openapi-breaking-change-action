# OpenAPI Breaking Change Checker

A GitHub Action that compares two versions of an OpenAPI or Swagger description and fails the check when a change would likely break existing API clients. Breaking changes appear as annotations on the pull request, and the full report goes to the job summary.

It reads Swagger 2.0 and OpenAPI 3.0 and 3.1, in JSON or YAML. It runs entirely inside your workflow: no service, no account, and your API description is never sent anywhere.

## Usage

Compare a file with its version on the pull request's base branch:

```yaml
name: API compatibility

on: pull_request

jobs:
  openapi:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0 # the base branch must be available to compare against
      - uses: MartinGryner/openapi-breaking-change-action@v1
        with:
          spec: openapi.yaml
```

Or compare two files directly:

```yaml
      - uses: MartinGryner/openapi-breaking-change-action@v1
        with:
          base: api/openapi-v1.yaml
          head: api/openapi-v2.yaml
```

## Inputs

| Input | Description |
| --- | --- |
| `spec` | Path to an OpenAPI or Swagger file. It is compared with the same file at `base-ref`. |
| `base-ref` | Git ref to read the earlier version from. Defaults to `origin/<base branch>` in a pull request, otherwise `HEAD~1`. |
| `base` | Path to the earlier description. Use together with `head` instead of `spec`. |
| `head` | Path to the new description. Use together with `base`. |
| `fail-on` | `breaking` (default) fails on likely breaking changes. `review` also fails on changes that need review. `never` only reports. |

If `spec` does not exist at `base-ref` (a new API), the step passes with a notice, because there is no earlier contract to break.

## Outputs

| Output | Description |
| --- | --- |
| `breaking` | Number of likely breaking changes. |
| `review` | Number of changes that need review. |
| `compatible` | Number of compatible changes. |
| `result` | `pass`, `fail`, or `skipped`. |
| `report` | Path to the Markdown report, for uploading as an artifact or posting as a comment. |

## What it checks

The report is written from the point of view of existing API consumers. It covers paths, operations, parameters, request bodies, responses, schemas, enum values, and security requirements, and resolves internal `$ref` references.

Each change is classified as:

- **Breaking**: existing clients are likely to fail, for example a removed operation, a new required parameter, or a removed response property.
- **Needs review**: the effect depends on how clients use the API.
- **Compatible**: existing calls keep working, for example a new optional field.

## Limits

The classification is a heuristic, not a proof. External `$ref` files and URLs are reported but not fetched. Runtime behavior, custom validation, callbacks, links, and undocumented compatibility promises still need a human review.

## Try it without CI

The same checker runs in the browser at [martingruner.com/tools/openapi-breaking-change-checker](https://martingruner.com/tools/openapi-breaking-change-checker): paste or open two descriptions and export the report.

For desktop review, [Diff Anything](https://martingruner.com/projects/diffanything) compares OpenAPI and JSON Schema files side by side on macOS and Windows, alongside folders, spreadsheets, archives, and code. On Windows, its command line with the Pro upgrade can fail a build only on breaking API changes and write JUnit or SARIF reports.

## Development

```sh
npm ci
npm test   # bundles src/ into dist/index.cjs and runs the tests
```

`dist/index.cjs` is committed, because GitHub runs the action from the repository without installing dependencies. Rebuild it after every change to `src/`.

## License

MIT
