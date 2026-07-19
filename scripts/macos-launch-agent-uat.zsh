#!/bin/zsh

set -eu

repo_root=${0:A:h:h}
service_label="com.conversational-memory.daemon"
user_domain="gui/$(id -u)"
plist_path="${HOME}/Library/LaunchAgents/${service_label}.plist"
temporary_directory=""
database_path=""
start_attempted=0

cleanup() {
  exit_code=$?
  trap - EXIT INT TERM

  if (( start_attempted == 1 )); then
    cd "$repo_root"
    npm run --silent memory:daemon -- stop --db "$database_path" >/dev/null 2>&1 || true
    /bin/launchctl bootout "$user_domain" "$plist_path" >/dev/null 2>&1 || true
    if [[ -f "$plist_path" ]]; then
      /bin/rm -f -- "$plist_path"
    fi
  fi

  if [[ -n "$temporary_directory" && "$temporary_directory" == /tmp/cms-launch-agent-uat.* ]]; then
    if (( exit_code == 0 )); then
      /bin/rm -rf -- "$temporary_directory"
    else
      print -u2 "Temporary diagnostic files retained at: $temporary_directory"
    fi
  fi

  exit $exit_code
}

trap cleanup EXIT INT TERM

if /bin/launchctl print "$user_domain/$service_label" >/dev/null 2>&1; then
  print -u2 "Refusing to run: $service_label is already loaded."
  exit 2
fi

if [[ -e "$plist_path" ]]; then
  print -u2 "Refusing to run: $plist_path already exists."
  exit 3
fi

temporary_directory=$(/usr/bin/mktemp -d /tmp/cms-launch-agent-uat.XXXXXX)
database_path="$temporary_directory/memory.sqlite"

cd "$repo_root"

print "LaunchAgent UAT"
print "  service: $service_label"
print "  database: temporary and empty"
print "  real history sources: not approved or accessed"

print "\n[1/5] Confirming stopped baseline"
npm run --silent memory:daemon -- status --db "$database_path"

print "\n[2/5] Starting disposable LaunchAgent"
start_attempted=1
npm run --silent memory:daemon -- start --db "$database_path"

print "\n[3/5] Inspecting generated plist and live service"
/usr/bin/plutil -lint "$plist_path"
/usr/bin/grep -F -- "$database_path" "$plist_path" >/dev/null
/usr/bin/grep -F -- "$repo_root/src/daemon/daemon-command.ts" "$plist_path" >/dev/null
/bin/launchctl print "$user_domain/$service_label" | /usr/bin/sed -n '1,80p'

print "\n[4/5] Reading database-backed status"
npm run --silent memory:daemon -- status --db "$database_path"

print "\n[5/5] Stopping and verifying cleanup"
npm run --silent memory:daemon -- stop --db "$database_path"

if /bin/launchctl print "$user_domain/$service_label" >/dev/null 2>&1; then
  print -u2 "FAILED: service is still loaded after stop."
  exit 4
fi

if [[ -e "$plist_path" ]]; then
  print -u2 "FAILED: generated plist still exists after stop."
  exit 5
fi

start_attempted=0
print "\nPASS: start, status, stop, service removal, and plist removal all verified."

