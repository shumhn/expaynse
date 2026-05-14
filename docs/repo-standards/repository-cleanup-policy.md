# Repository Cleanup Policy

## Goals

- Keep the codebase professional and predictable.
- Preserve all pitch materials and visual artifacts needed for demos.
- Reduce noise in root and keep runtime vs non-runtime assets separate.

## File Placement Rules

- Runtime UI assets belong in `public/`.
- Non-runtime references (pitch snapshots, archived decks, branding drafts) belong in `assets/`.
- Documentation and conventions belong in `docs/`.
- Business/domain helpers should live next to their feature when possible (`app/<feature>/`).

## Naming Rules

- Use kebab-case for files and folders unless framework conventions require otherwise.
- React components: `PascalCase` file names are allowed and expected.
- Route files should follow Next.js conventions (`page.tsx`, `layout.tsx`, `route.ts`).

## Route Structure Rules

- Keep `app/**/page.tsx` thin.
- Move heavy page logic into sibling modules such as:
  - `<feature>-page-content.tsx`
  - `<feature>-helpers.ts`
  - `<feature>-types.ts`

## Package Manager & Lockfiles

- Use one package manager per project folder.
- Root uses `npm` (`package-lock.json`).
- `payroll1-rust/` also uses `npm`; remove `yarn.lock` and `pnpm-lock.yaml`.

## Test & Script Consistency

- Scripts that require secrets or DB access must load `.env`.
- Prefer alias scripts over duplicate command strings.

## Protected Artifacts

- Do not delete pitch-related files.
- Archive pitch files under `assets/pitch/` instead of keeping them in root.
