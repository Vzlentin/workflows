# Upstream

- Source: https://github.com/dmmulroy/anti-slop
- Commit: 13909c9e07590f5a85d93c62712259fe14a883f7
- Copied from `skills/install-anti-slop/assets/anti-slop/` at that commit, which is `src/` without the rule tests.
- Entry point: `tools/oxlint/anti-slop/index.ts`, registered in the `lint` section of `vite.config.ts`. The Effect plugin in `effect/` is copied but not registered.
- Oxlint and `@oxlint/plugins`: 1.91.0, from `vite-plus` 1.5.0.
- Local changes:
  - The rules import from `vite-plus/lint/plugins`, which re-exports `@oxlint/plugins`.
  - `no-module-mocking` also finds `vi` imported from `vite-plus/test`.
