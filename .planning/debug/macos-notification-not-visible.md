---
status: deferred
trigger: "Phase 04 UAT Test 2: expected a visible macOS notification for a synthetic degraded-source episode, but no notification appeared after two sends even though MacOSNotificationAdapter returned {capable:true, delivered:true}; osascript exited 0."
created: 2026-07-18T18:47:01Z
updated: 2026-07-18T20:05:44Z
---

## Current Focus

hypothesis: "DEFERRED BY PRODUCT DECISION: after Script Editor was explicitly authorized, one fixed synthetic send was command-accepted but still produced no visible banner."
test: "The live receipt remained presentation=unverified and the user's direct observation was absent; no retry was sent."
expecting: "Local daemon status remains the authoritative operational surface while a native notification sender is postponed."
next_action: "None until desktop notifications are explicitly returned to scope; do not infer delivery from command acceptance."

## Symptoms

expected: A visible macOS notification appears for a synthetic degraded-source episode and contains only controlled operational metadata.
actual: User saw no notification on any of three monitors after two sends. MacOSNotificationAdapter returned {capable:true, delivered:true} both times.
errors: none from osascript; subprocess exit code 0.
reproduction: Test 2 in .planning/phases/04-continuous-local-daemon/04-UAT.md, using sourceLabel codex_candidate_synthetic, permission_denied, attempt 3.
started: Discovered during live UAT on 2026-07-18.

## Eliminated

- hypothesis: "The notification failed because the process was outside the active logged-in GUI user domain or Notification Center was unavailable."
  evidence: "uid 501 matches /dev/console owner and gui/501 has active usernoted/UserNotificationCenterAgent services."
  timestamp: 2026-07-18T18:53:00Z

- hypothesis: "The degraded-source trigger or one-shot latch prevented the UAT notification command from running."
  evidence: "Two direct live sends reached osascript and returned exit 0; the failure is downstream of triggering/latching."
  timestamp: 2026-07-18T18:53:00Z

- hypothesis: "Codex notification permission should authorize this notification."
  evidence: "The OS attributes osascript display notification to com.apple.ScriptEditor2, while the live preferences contain com.openai.codex but no Script Editor entry."
  timestamp: 2026-07-18T18:53:00Z

## Evidence

- timestamp: 2026-07-18T18:48:06Z
  checked: Phase 04 UAT and verification reports
  found: "The live human check is the sole presentation proof; deterministic tests explicitly inject/fake osascript and verification states that live Notification Center presentation cannot be proven by them. Two live sends exited 0 but produced no visible notification."
  implication: "The failure is beyond the covered unit-test boundary and cannot be dismissed by the green adapter test."

- timestamp: 2026-07-18T18:48:06Z
  checked: src/daemon/macos/notification.ts and NodeCommandRunner
  found: "MacOSNotificationAdapter sets capable=true from platform/command presence and delivered=true solely when NodeCommandRunner reports subprocess exitCode===0. It receives no Notification Center identifier, presentation callback, or user-visible acknowledgement."
  implication: "The returned delivered flag is semantically commandAccepted/scriptSucceeded, not evidence that a banner was presented."

- timestamp: 2026-07-18T18:48:06Z
  checked: tests/daemon/macos-adapters.test.ts and tests/daemon/scheduler.test.ts
  found: "The macOS adapter test uses FakeCommandRunner and defines exitCode 0 as delivered=true; it never interrogates Notification Center. Scheduler tests prove one-shot latching and privacy but use FakeNotificationAdapter."
  implication: "Tests encode the false-positive delivery assumption and cannot falsify silent OS suppression."

- timestamp: 2026-07-18T18:48:06Z
  checked: src/daemon/source-state.ts, src/daemon/daemon.ts, and src/daemon/daemon-command.ts
  found: "Production emits after durable latching and intentionally swallows notifier failures. The default wrapper also discards NotificationDelivery. A separate direct UAT invocation did reach osascript twice, so source-state latching is not the cause of this observed no-banner result."
  implication: "The divergence lies at or after the osascript-to-Notification-Center boundary, not in degraded-episode triggering."

- timestamp: 2026-07-18T18:48:06Z
  checked: .planning/debug/knowledge-base.md
  found: "No project debug knowledge base exists."
  implication: "There is no known-pattern diagnosis to prioritize."

- timestamp: 2026-07-18T18:53:00Z
  checked: read-only macOS session and service diagnostics
  found: "The process runs as uid 501, matching the /dev/console owner, and launchctl gui/501 contains active usernoted and UserNotificationCenterAgent services."
  implication: "A missing logged-in GUI session or absent Notification Center service is eliminated."

- timestamp: 2026-07-18T18:53:00Z
  checked: local osascript manual and Apple AppleScript command documentation
  found: "osascript reports script execution errors, while display notification returns no result. Apple documents that presentation is controlled by notification preferences and may be configured not to display at all."
  implication: "Exit 0 is command/script acceptance only; the API supplies no delivery or presentation receipt."

- timestamp: 2026-07-18T18:53:00Z
  checked: live com.apple.ncprefs domain and Script Editor application identity
  found: "Script Editor's installed bundle id is com.apple.ScriptEditor2. The active notification preferences enumerate 103 bundle ids and include com.openai.codex (auth 7) but contain no com.apple.ScriptEditor2 entry."
  implication: "The osascript-attributed notification source has not been registered/authorized for notifications on this host; Codex's own permission does not apply."

- timestamp: 2026-07-18T18:53:00Z
  checked: platform-specific reports for macOS Sequoia and Apple notification attribution documentation
  found: "Independent modern-macOS reproductions show the exact signature: osascript display notification exits successfully but NotificationCenter logs identify com.apple.ScriptEditor2 with notificationsAllowed:false; authorizing Script Editor makes the same Terminal command visible. Apple also documents script/Script Editor notification attribution."
  implication: "This matches both the local missing Script Editor preference entry and the observed silent two-send failure."

- timestamp: 2026-07-18T18:53:00Z
  checked: Focus and unified-log diagnostics
  found: "Legacy defaults keys do not expose an active Focus value on macOS 26, DoNotDisturb databases are privacy-protected, and unified logs cannot be queried from this sandbox."
  implication: "Focus cannot be independently ruled in or out, but it is not required to explain the failure because the Script Editor authorization prerequisite is already absent."

- timestamp: 2026-07-18T18:54:00Z
  checked: npx vitest run tests/daemon/macos-adapters.test.ts -t MacOSNotificationAdapter
  found: "2 selected tests passed. The success case uses FakeCommandRunner exitCode 0 and immediately expects delivered=true; no OS or Notification Center observation occurs."
  implication: "The adapter-contract hypothesis is directly confirmed: delivered means subprocess success, not presentation."

## Resolution

root_cause: "MacOSNotificationAdapter uses /usr/bin/osascript display notification, which modern macOS attributes to Script Editor (com.apple.ScriptEditor2). This host has no Script Editor notification authorization entry, so Notification Center silently suppresses the banner. osascript still exits 0 because display notification has no delivery result, and the adapter incorrectly maps that exit code to delivered:true. Focus could additionally suppress banners, but is neither observable from this sandbox nor needed to explain the failure."
fix:
verification: "Diagnosis confirmed without another live notification: active GUI services present; live notification preferences lack com.apple.ScriptEditor2; Apple documents no result and preference-controlled non-presentation; focused adapter tests prove exitCode 0 alone yields delivered:true."
files_changed: [.planning/debug/macos-notification-not-visible.md]
decision: "Desktop notifications are deferred. The original missing-authorization diagnosis remains historical evidence for the first attempts, while the later authorized-but-absent attempt shows that authorization alone did not close presentation."
