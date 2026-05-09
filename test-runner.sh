#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

echo "======================================"
echo "Running BEC-183 pre-stream stall tests"
echo "======================================"

cd packages/core
npx vitest run src/__tests__/bec-183-pre-stream-stall.test.ts

echo ""
echo "======================================"
echo "Running all unit tests"
echo "======================================"

npx vitest run

echo ""
echo "======================================"
echo "Test run complete!"
echo "======================================"
