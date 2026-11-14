#!/bin/zsh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo 'Install Node.js 24 or newer, then open this launcher again.'
  read '?Press Enter to close.'
  exit 1
fi
npm start
if [ $? -ne 0 ]; then
  echo '\nThe server could not start. Review the error above.'
  read '?Press Enter to close.'
fi
