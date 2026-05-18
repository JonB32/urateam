#!/bin/bash
set -e

cd /home/ura/data/runs/mI_gBAE8g0yUsb-KxFRiI/worktree

echo "Running pnpm test..."
pnpm test

echo ""
echo "Test run completed successfully"
