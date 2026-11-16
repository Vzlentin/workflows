#!/usr/bin/env bash
# A published package must not depend on a Git pin. Workflows pins harness by Git SHA during
# development, so this check stops a release or a publish until harness is on npm and package.json names its range.
set -euo pipefail

spec=$(node -p "require('./package.json').dependencies['@vzlentin/harness']")
range='^[~^]?[0-9]+\.[0-9]+\.[0-9]+$'
if [[ $spec =~ $range ]]; then
  echo "@vzlentin/harness is $spec"
  exit 0
fi
echo "::error::@vzlentin/harness is $spec, not a registry range such as ^x.y.z. Release harness, wait until npm shows it, then set its range in package.json."
exit 1
