---
status: diagnosed
trigger: "Diagnose the remaining Phase 04 live notification failure after explicit Script Editor authorization and exactly one accepted synthetic smoke command. Find root cause only. Do not send any more notifications, do not change System Settings, and do not implement a fix."
created: 2026-07-18T19:53:46Z
updated: 2026-07-18T20:23:00Z
---

## Current Focus

hypothesis: "CONFIRMED at the implementation boundary: macOS 26.4.1 accepts the legacy osascript display-notification command but does not reliably register/present it; the adapter's capability check proves only that the executable exists, not that this OS path can post a notification."
test: "Correlate the exact live signature with executable entitlements, current notification registration, Apple API contracts, and macOS 26 reports; no additional notification send permitted."
expecting: "Diagnosis only; no fix authorized."
next_action: "Return ROOT CAUSE FOUND to the orchestrator."

## Symptoms

expected: after explicit Script Editor notification authorization, the one approved synthetic smoke command should display a visible macOS notification banner
actual: the smoke receipt reported capable true and commandAccepted true with presentation unverified and Script Editor identity, but the user observed no banner
errors: no process error; receipt identity displayName Script Editor and bundleIdentifier com.apple.ScriptEditor2; presentation remained unverified
reproduction: authorize Script Editor notifications, run npm run memory:daemon:notification-smoke exactly once, observe no banner
started: remaining Phase 04 live UAT failure after explicit authorization; prior missing-authorization diagnosis is disproved as sufficient

## Eliminated

- hypothesis: Script Editor notification authorization is missing and solely explains the absent banner
  evidence: user explicitly authorized Script Editor notifications before the accepted smoke command, yet no banner appeared
  timestamp: 2026-07-18T19:53:46Z

- hypothesis: the smoke command never reached the display-notification statement
  evidence: commandAccepted true is produced only after execFile('/usr/bin/osascript', ['-e', 'display notification ...']) completes with exit code zero; the fixed smoke path calls the production adapter exactly once
  timestamp: 2026-07-18T20:23:00Z

- hypothesis: the adapter selected the wrong Script Editor identity and osascript has no authority to use it
  evidence: the identity is hard-coded rather than passed as an argument, but the signed /usr/bin/osascript executable carries com.apple.developer.notificationcenter-identifiers = [com.apple.ScriptEditor2], matching Script Editor's signed bundle identifier
  timestamp: 2026-07-18T20:23:00Z

- hypothesis: no logged-in GUI notification service was available
  evidence: uid 501 matches the console owner and launchctl shows active com.apple.usernoted and com.apple.UserNotificationCenterAgent services in gui/501
  timestamp: 2026-07-18T20:23:00Z

- hypothesis: a separate app bundle is strictly required for osascript to attribute the notification to Script Editor
  evidence: osascript's Apple-signed private notification-center entitlement explicitly authorizes com.apple.ScriptEditor2 attribution
  timestamp: 2026-07-18T20:23:00Z

## Evidence

- timestamp: 2026-07-18T19:53:46Z
  checked: supplied smoke receipt and human observation
  found: capable true and commandAccepted true coexist with presentation unverified and an absent banner
  implication: process acceptance is not evidence of presentation; the remaining fault lies after command construction/acceptance or in the meaning of the reported identity

- timestamp: 2026-07-18T20:02:00Z
  checked: src/daemon/macos/notification.ts and notification-smoke-command.ts
  found: the production smoke calls execFile('/usr/bin/osascript', ['-e', 'display notification ...']) exactly once; the hard-coded MACOS_NOTIFICATION_IDENTITY object is only returned in the receipt and is never passed to osascript or any Notification Center API
  implication: display notification is actually executed when commandAccepted is true, but the receipt does not establish, select, or authenticate the OS sender identity

- timestamp: 2026-07-18T20:02:00Z
  checked: tests/daemon/macos-adapters.test.ts and macos-notification-smoke.test.ts
  found: all acceptance and identity assertions use a fake command runner; tests assert the hard-coded identity object and exit-code mapping without observing the OS-attributed bundle, notification request registration, delivery, suppression, or presentation
  implication: automated coverage proves command construction and receipt semantics only; it cannot prove that macOS accepted a notification request under com.apple.ScriptEditor2

- timestamp: 2026-07-18T20:08:00Z
  checked: current macOS 26.4.1 host metadata and notification preferences after the reported authorization
  found: Script Editor is installed with CFBundleIdentifier com.apple.ScriptEditor2; the process uid matches the console uid and launchctl shows active usernoted and UserNotificationCenterAgent services, but both the current defaults export and on-disk com.apple.ncprefs plist contain no com.apple.ScriptEditor2 entry while com.openai.codex is present with auth 7
  implication: the UI action did not yield a readable effective notification registration for Script Editor on this host; a healthy GUI notification service and console session rule out absence of the basic desktop notification processes

- timestamp: 2026-07-18T20:08:00Z
  checked: unified notification logs and process list
  found: the managed sandbox denies /usr/bin/log access and process enumeration, so the accepted smoke command's effective sender attribution and any suppression reason cannot be observed directly
  implication: Focus and per-request Notification Center suppression cannot be independently ruled in or out from logs, but neither can establish the missing sender registration or make the hard-coded receipt identity operational

- timestamp: 2026-07-18T20:15:00Z
  checked: /usr/bin/osascript and Script Editor code signatures
  found: osascript is signed as com.apple.osascript and carries the private entitlement com.apple.developer.notificationcenter-identifiers containing com.apple.ScriptEditor2; Script Editor itself is signed as com.apple.ScriptEditor2
  implication: although the adapter identity object is only declarative, it matches an OS-enforced entitlement on the actual executable; authorizing Script Editor is conceptually the correct target, and a separate app bundle is not proven necessary merely to obtain Script Editor attribution

- timestamp: 2026-07-18T20:15:00Z
  checked: Apple Mac Automation Scripting Guide and UserNotifications documentation
  found: Apple documents display notification as preference-controlled and identifies the script or Script Editor when run inside Script Editor; the modern UNUserNotificationCenter contract instead provides explicit per-app authorization status, request completion, pending requests, and delivered-notification queries
  implication: osascript remains a legacy best-effort boundary with no request identifier or delivery query, whereas a bundled UserNotifications sender would make authorization and request admission observable; Focus/display policy can still suppress banners after admission

- timestamp: 2026-07-18T20:23:00Z
  checked: Apple Developer Forums reports for macOS Tahoe 26
  found: an independent macOS 26 report reproduces the exact command and exact signature: osascript -e display notification returns 0 with no output and no visible notification despite checking Terminal and Script Editor notification settings; the report says the behavior stopped after the Tahoe migration
  implication: the live failure is a known macOS-26-specific failure mode of the selected legacy mechanism, not evidence that the daemon failed to invoke it

- timestamp: 2026-07-18T20:23:00Z
  checked: Phase 4 research and implementation contract
  found: the phase research classified osascript notification behavior as version-sensitive and best-effort, but MacOSNotificationAdapter defines capable solely from platform/executable presence and cannot observe authorization status, request admission, delivered records, or presentation
  implication: the root defect is the capability model at the OS adapter boundary; on macOS 26, executable presence plus exit zero is insufficient even after the user enables the attributed app

- timestamp: 2026-07-18T20:23:00Z
  checked: read-only usernoted store and Focus diagnostics
  found: the authoritative group.com.apple.usernoted store and unified logs are sandbox-protected, and current Focus state is not exposed through readable defaults
  implication: the OS-internal branch between request rejection and later presentation suppression cannot be named from this environment; Focus could additionally hide a banner, but it is not the only remaining explanation and does not remove the confirmed incompatibility of this adapter path on macOS 26

- timestamp: 2026-07-18T20:23:00Z
  checked: .planning/debug/knowledge-base.md
  found: no project debug knowledge base exists
  implication: no known project pattern was available to prioritize

## Resolution

root_cause: "MacOSNotificationAdapter treats the existence of /usr/bin/osascript as notification capability, but on macOS 26.4.1 the legacy Standard Additions display-notification path can execute successfully (exit 0) without registering or presenting a notification, including after Script Editor is enabled. The hard-coded Script Editor receipt does not itself cause attribution, although the osascript binary's Apple-signed entitlement does independently validate com.apple.ScriptEditor2 as the intended identity. Thus the failure is the selected macOS-26-incompatible/unobservable notification transport and its false capability model, not the daemon trigger. A protected Focus/display policy may additionally suppress presentation, but is not required to explain the exact Tahoe failure signature."
fix:
verification: "Diagnosis only, with no additional notification: production call path and fake-test boundary read completely; macOS 26.4.1 confirmed; osascript entitlement matches Script Editor; active GUI services confirmed; readable preferences still lack com.apple.ScriptEditor2; Apple documentation confirms preference-controlled legacy behavior and modern UserNotifications observability; independent macOS 26 report matches exit-0/no-banner behavior."
files_changed: [.planning/debug/script-editor-notification-absent.md]
