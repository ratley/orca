# orca

Orca is a TypeScript CLI harness for coordinated agent planning and execution from spec markdown files.

## Install

```bash
npm install
npm run build
npm link
```

## Usage

```bash
orca run --spec ./specs/myfeature.md
orca plan --spec ./specs/myfeature.md
orca status --run <run-id>
orca status
orca list
orca resume --run <run-id>
orca cancel --run <run-id>
orca pr-finalize --run <run-id>
```

Run IDs follow this format:

```text
<spec-slug>-<timestamp-ms>-<4char-hex>
```

Global run status defaults to:

```text
~/.orca/runs/<run-id>/status.json
```
