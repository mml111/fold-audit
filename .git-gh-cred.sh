#!/bin/sh
# git credential helper: supplies the gh account and token for github.com
if [ "$1" = "get" ]; then
  echo "username=mml111"
  echo "password=$(gh auth token)"
fi
