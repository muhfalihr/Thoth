# React + TypeScript + Vite

## Python v1 workflow dashboard

The **New video** workflow uses generated OpenAPI types and the Python control plane's
`/api/v1/workflows` product contract. Configure the local Vite process with
`VITE_CONTROL_PLANE_URL=http://127.0.0.1:8000` and inject
`VITE_CONTROL_PLANE_API_KEY` without printing or committing its value, then run `bun run dev`.

Generate/check the client and verify the dashboard with:

```powershell
bun run generate:control-plane-types
bun test
bun run build
bun run lint
```

The existing Scout console remains on the legacy Rust API and `VITE_THOTH_API_KEY`; it is not the
v1 workflow path. The ordinary v1 screen exposes Source, Style, Review, Progress, Decisions,
Results, Cancel, and Retry rather than Scout executor flags or stdout-driven state. See
[`docs/python-control-plane.md`](../docs/python-control-plane.md) for the four-process local stack,
SSE reconnect rule, authorization, redaction, and adapter retirement gate.

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.
