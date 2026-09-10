#!/bin/sh
# macOS: двойной щелчок, затем нажмите кнопку в окне плагина в Figma.
# Не закрывайте это окно, пока перенос не скажет, что закончил.
#
# Если двойной щелчок ничего не делает, у файла потерялся бит исполнения — в Терминале, один раз:
#   chmod +x start.command
cd "$(dirname "$0")/tools" || exit 1

# Терминал, запущенный из Finder, не всегда наследует PATH, который настроил пакетный менеджер, а
# "node: command not found" человеку ничего не объясняет. Поищем Node там, где он обычно лежит.
if ! command -v node >/dev/null 2>&1; then
  for p in /usr/local/bin /opt/homebrew/bin "$HOME/.nvm/versions/node"/*/bin; do
    [ -x "$p/node" ] && PATH="$p:$PATH" && export PATH && break
  done
fi
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js не установлен, или его нет в PATH, который видит это окно."
  echo "Поставьте его с https://nodejs.org (сборка LTS) и запустите этот файл ещё раз."
  exit 1
fi

node run.mjs "$@"
echo
echo "Это окно можно закрыть."
