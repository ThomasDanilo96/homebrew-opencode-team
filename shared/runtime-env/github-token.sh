#!/bin/bash

if [ -z "${GH_TOKEN:-}" ]; then
  token="$(gh auth token 2>/dev/null || true)"
  if [ -n "$token" ]; then
    export GH_TOKEN="$token"
  fi
  unset token
fi
