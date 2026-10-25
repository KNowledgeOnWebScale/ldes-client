#!/usr/bin/env sh
set -eu

CLIENT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SUITE_ROOT="$CLIENT_ROOT/../ldes-client-conformance-test-suite"
SUITE_REPOSITORY="https://github.com/pietercolpaert/ldes-client-conformance-test-suite.git"

if [ ! -d "$SUITE_ROOT" ]; then
    git clone "$SUITE_REPOSITORY" "$SUITE_ROOT"
fi

npm run build
if [ ! -d "$SUITE_ROOT/node_modules" ]; then
    npm --prefix "$SUITE_ROOT" ci
fi
npm --prefix "$SUITE_ROOT" run build

cd "$SUITE_ROOT"
LDES_CT_RDF_CONNECT_ROOT="$CLIENT_ROOT" node dist/cli.js run \
    --adapter rdf-connect \
    --tests tests \
    --out "$CLIENT_ROOT/reports/conformance" \
    "$@"
