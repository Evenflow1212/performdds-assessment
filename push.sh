#!/bin/bash
cd ~/Desktop/performdds
rm -f .git/index.lock .git/HEAD.lock
git add -A
git commit -m "${1:-Auto-commit}"
git push
