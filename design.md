# Takosumi Web design

The application uses an iOS Settings-like hierarchy: quiet grouped rows,
clear current values, and one primary action for the current task. This is the
shared design for Home, Store, install, app management, connections and account.
The existing app icons and Takosumi brand remain unchanged.

## Visual system

- The sole token source is `dashboard/src/styles/tokens.css`. Use its `--tg-*`
  roles for colour, spacing, type, corners and motion; do not introduce a parallel theme.
- Use system sans-serif including Japanese, normal headings, neutral flat surfaces,
  hairline separators and one restrained brand accent. Dark is the default;
  preserve light/system and the user's saved preference.
- Use short labelled rows with their current value. Group related rows once;
  avoid nested cards, decorative badges, gradients, oversized display headings,
  repeated subtitles and explanations of self-evident buttons.
- Interactive targets are at least 44 CSS pixels. Use visible keyboard focus,
  readable contrast, reduced motion and stable space for loading/error states.
- Home retains the app icon grid and natural scrolling. Store is a searchable
  list of real apps; app details retain real publisher, description and media.

## Interaction and copy

- From an app detail, standard install takes two primary actions: start setup,
  then explicitly install the reviewed changes. Reading and planning advance
  automatically. Required inputs are visible in the same setup surface.
- A configuration selection updates the choice once; it does not require another
  confirmation. Only declared defaults or unique valid candidates are preselected.
  Keep latest distinct from an explicitly selected or resumed pinned version.
- Show the selected account/connection, known cost and consequential changes
  before applying. Unknown cost is not free. Destructive and policy-required
  approvals remain explicit. Never equate successful Apply with a usable app.
- Show a fact once. Normal success updates its existing row/button. Errors say
  what failed and how to recover, beside the affected control. Retain inputs,
  attempt identity, scroll position and focus across retry or return.
- App management stays on the same app: Settings, Version, Connections, History,
  Resources and Sharing are identifiable destinations. Do not remove capabilities
  merely to reduce the initial screen. Old links keep their meaning.
- Button labels name the outcome. Copy supports a real decision, state or recovery;
  do not fill empty space with reassurance or implementation explanations.

## Verification

Verify desktop and 320/375/414/768 px, Japanese/English, dark/light, keyboard,
long names, loading, empty, unavailable, invalid, success and failure states.
Use the existing portable browser fixture or an authorized dedicated test account,
never the user's account. Compare the same journeys before and after; record actual
requests, decisions and screenshots rather than treating a passing build as UX proof.
