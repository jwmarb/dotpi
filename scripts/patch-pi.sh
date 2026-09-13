#!/usr/bin/env bash
# Re-apply local patches to the installed pi package.
#
# Every `pi` update overwrites node_modules and silently reverts these, after
# which chat dies permanently on the first litellm hiccup. Run this after any
# update. Safe to run repeatedly: each patch is skipped if already present.
#
# See docs/adr/0034-local-pi-patches.md for why each patch exists.
set -uo pipefail

PKG="${PI_PKG_DIR:-$HOME/.bun/install/global/node_modules/@earendil-works/pi-coding-agent}"
fail=0
ok()   { printf '  \033[32mok\033[0m    %s\n' "$1"; }
skip() { printf '  \033[36malready\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31mFAILED\033[0m %s\n' "$1"; fail=1; }

if [[ ! -d $PKG ]]; then
	echo "pi package not found at: $PKG" >&2
	echo "Set PI_PKG_DIR to its location and re-run." >&2
	exit 1
fi

printf 'Patching %s\n' "$PKG"
printf 'version: %s\n\n' "$(grep -m1 '"version"' "$PKG/package.json" | tr -d ' \t",' | cut -d: -f2)"

# The retryable-error list and the retry ladder are INLINED into a bundled
# chunk. The loose `@earendil-works/pi-ai/dist/utils/retry.js` looks like the
# right target and is never loaded — patching it appears to work and changes
# nothing. Find the chunk by content, not by name: the hash changes per release.
CHUNK=$(grep -l 'provider.?returned.?error' "$PKG"/dist/bundle/chunks/*.js 2>/dev/null | head -1)

if [[ -z ${CHUNK:-} ]]; then
	bad "retry chunk not found — the bundle layout changed; see the ADR"
else
	printf 'chunk: %s\n' "$(basename "$CHUNK")"
	[[ -f $CHUNK.orig-backup ]] || cp "$CHUNK" "$CHUNK.orig-backup"

	# 1. litellm returns HTTP 400 for an upstream failure, which pi classifies as
	#    permanent, so a retryable gateway blip ends the session for good.
	if grep -q 'upstream request failed' "$CHUNK"; then
		skip 'retryable: "upstream request failed"'
	elif python3 - "$CHUNK" <<-'PY'
		import sys
		p = sys.argv[1]; s = open(p).read()
		old = '"overloaded","rate.?limit"'
		new = '"overloaded","upstream request failed","rate.?limit"'
		if s.count(old) != 1: sys.exit(1)
		open(p, "w").write(s.replace(old, new)); sys.exit(0)
	PY
	then ok 'retryable: "upstream request failed"'
	else bad 'retryable pattern anchor not found'
	fi

	# 2. The outer ladder is baseDelayMs * 2^(n-1) with NO ceiling, so 10 retries
	#    reach 17-minute waits. `retry.maxRetryDelayMs` in settings.json is the
	#    provider SDK's knob and does not apply here.
	if grep -q 'settings2.maxDelayMs' "$CHUNK"; then
		skip 'ladder capped at retry.maxDelayMs'
	elif python3 - "$CHUNK" <<-'PY'
		import sys
		p = sys.argv[1]; s = open(p).read()
		old = 'let delayMs=settings2.baseDelayMs*2**(this._retryAttempt-1);'
		new = 'let delayMs=Math.min(settings2.baseDelayMs*2**(this._retryAttempt-1),settings2.maxDelayMs??128e3);'
		if s.count(old) != 1: sys.exit(1)
		open(p, "w").write(s.replace(old, new)); sys.exit(0)
	PY
	then ok 'ladder capped at retry.maxDelayMs'
	else bad 'ladder formula anchor not found'
	fi
fi

echo
if (( fail )); then
	cat <<-'EOF'
	One or more patches did not apply. pi will run, but a litellm "Upstream
	request failed" will end the session permanently instead of retrying.
	Read docs/adr/0034-local-pi-patches.md and re-derive the anchors.
	EOF
	exit 1
fi

cat <<-'EOF'
All patches applied. Verify with:

  bun -e 'const s=await Bun.file(process.env.C).text();
    const t=JSON.parse(s.match(/\["overloaded",(?:"[^"]*",?)+\]/)[0]);
    console.log(new RegExp(t.join("|"),"i").test("400: Upstream request failed") ? "retries OK" : "NOT RETRYING")' \
  C=$(grep -l 'provider.?returned.?error' "$PKG"/dist/bundle/chunks/*.js | head -1)

Then restart pi: the patched chunk is loaded once at startup.
EOF
