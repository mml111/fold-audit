#!/usr/bin/env bash
# Publish fold-audit to GitHub.
#
# Requires the GitHub CLI authenticated:  gh auth login
# Choose a repo name first — "fold-audit" is unclaimed as of 2026-11-09.
#
# Run from inside the repository directory.

set -euo pipefail

NAME="${1:-fold-audit}"
ORG="${2:-}"

if ! gh auth status >/dev/null 2>&1; then
  echo "Not authenticated. Run: gh auth login"
  exit 1
fi

# Reproducible results before publishing.
node --experimental-strip-types tests/suite.test.ts
node --experimental-strip-types src/cli.ts \
  --window 600000 --turns 3000 --turnTokens 1000 --giant 300000 \
  --backends baseline,naive,reference,reference-cold \
  --report results/matrix.json

git add -A
git commit -m "reproducible results" || true

if [[ -n "$ORG" ]]; then
  gh repo create "$ORG/$NAME" --private=false --source . --description \
    "Conformance harness for context compaction: turns 'lossless', 'cache-friendly' and 'independent' into measured arithmetic"
else
  gh repo create "$NAME" --private=false --source . --description \
    "Conformance harness for context compaction: turns 'lossless', 'cache-friendly' and 'independent' into measured arithmetic"
fi

echo "Pushed. Next:"
echo "  - pin the topic: gh repo view $NAME --json description,repositoryTopics"
echo "  - create a release tag: git tag v0.1.0 && git push origin v0.1.0"
echo "  - run the CI: gh run list"
