#!/usr/bin/env bash
set -euo pipefail

# Hosted jobs only: no machine-wide installations or trust-store modifications.
[ "$RUNNER_ENVIRONMENT:$RUNNER_OS:$RUNNER_ARCH" = 'github-hosted:Linux:X64' ]
[ "$(node --version)" = 'v24.22.1' ]
[ "$("$ACTIONS_NODE" --version)" = 'v24.22.1' ]
printf 'Application Node: %s (%s)\n' "$(node --version)" "$(command -v node)"
printf 'Actions Node: %s (%s)\n' "$("$ACTIONS_NODE" --version)" "$ACTIONS_NODE"
printf 'Hosted commit: %s\n' "$(git rev-parse HEAD)"
printf 'Hosted runner image: %s / %s\n' "${ImageOS:-unknown}" "${ImageVersion:-unknown}"
curl --version
git --version --build-options
dpkg-query --show --showformat '${Package} ${Version}\n' ca-certificates
printf 'Runner-provided GitHub CLI before replacement:\n'
GH_NO_UPDATE_NOTIFIER=1 gh --version
GOTOOLCHAIN=local go version -m "$(command -v gh)"

# Release 2.102.1 is built with the protected Go 1.27.3 crypto/x509 implementation.
# The archive digest is pinned from the official GitHub release asset metadata.
GH_DIR="$(mktemp -d "$RUNNER_TEMP/qwt-gh.XXXXXX")"
GH_ARCHIVE="$GH_DIR/gh.tar.gz"
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
  --connect-timeout 15 --max-time 120 --retry 2 --retry-max-time 300 \
  https://github.com/cli/cli/releases/download/v2.102.1/gh_2.102.1_linux_amd64.tar.gz \
  --output "$GH_ARCHIVE"
printf '%s  %s\n' '77b9e297e94c50336823d0f84de7ef1be60cba704601fa0d98f129f47a94987b' "$GH_ARCHIVE" | sha256sum --check --status
tar -xzf "$GH_ARCHIVE" -C "$GH_DIR"
GH_BIN="$GH_DIR/gh_2.102.1_linux_amd64/bin"
GH_VERSION="$(GH_NO_UPDATE_NOTIFIER=1 "$GH_BIN/gh" --version)"
[[ "$GH_VERSION" == 'gh version 2.102.1 '* ]]
printf '%s\n' "$GH_VERSION"
GH_BUILD="$(GOTOOLCHAIN=local go version -m "$GH_BIN/gh")"
printf '%s\n' "$GH_BUILD"
[ "$(printf '%s\n' "$GH_BUILD" | awk 'NR == 1 { print $NF }')" = 'go1.27.3' ]
printf '%s\n' "$GH_BIN" >> "$GITHUB_PATH"
printf 'GH_NO_UPDATE_NOTIFIER=1\n' >> "$GITHUB_ENV"
