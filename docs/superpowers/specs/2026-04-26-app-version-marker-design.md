# App Version Marker Design

## Goal

Add a small application version marker so users can see which BillBoard build they are using, while keeping the maintained version value in one obvious place.

## Scope

- Add `version: "0.1.0"` to the root `package.json`.
- Display the version as `v0.1.0` inside the authenticated application shell.
- Keep the change limited to version metadata and presentation.
- Do not add deployment tagging, Git tags, release notes, or CI automation.

## Assumptions

- The initial application version is `0.1.0`.
- `package.json` should be the single source of truth for the app version.
- The marker is informational only and should not affect navigation, filtering, authentication, or data behavior.

## Selected Approach

Use `package.json` as the only maintained version source and expose that value to the app shell. The UI should render it with a leading `v`, such as `v0.1.0`.

Desktop placement should be in the left navigation sidebar near the bottom, using subdued text so it is visible but not competing with primary navigation. Mobile placement should be small and unobtrusive around the bottom navigation area, without blocking taps or shifting the existing route labels.

## Alternatives Considered

1. Duplicate the version in a local app file such as `src/lib/app-version.ts`.
   This is simple, but it creates two values that can drift.

2. Inject the version with an environment variable such as `NEXT_PUBLIC_APP_VERSION`.
   This is useful for automated release pipelines, but it is heavier than needed for the current project.

## Components And Data Flow

- `package.json` stores `0.1.0`.
- A tiny local helper or component reads the package version at build time.
- `AppShell` or its navigation children render the formatted label.
- The version marker is shown only inside the authenticated app layout because that is where the persistent navigation exists.

## Error Handling

No user-facing error handling is needed. If the version value is missing during development, the implementation may fall back to a neutral label such as `v0.0.0`, but the normal path is to keep `package.json` complete.

## Testing And Verification

- Verify `package.json` contains `version: "0.1.0"`.
- Verify the app shell renders `v0.1.0`.
- Run `npm run lint`.
- Run targeted component or integration tests only if existing tests already cover the app shell or navigation.

