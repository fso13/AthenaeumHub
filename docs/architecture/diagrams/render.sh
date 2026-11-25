#!/usr/bin/env bash
# Рендер всех PlantUML-исходников в SVG (для docs) и PNG (для ревью/презентаций).
#
# Требования:
#   - plantuml (>= 1.2024) в PATH;
#   - Java 17+;
#   - сеть при первом рендере C4-диаграмм: PlantUML подтягивает stdlib C4-PlantUML.
#     Если сеть недоступна, положите C4-*.puml в локальный stdlib или используйте
#     уже отрендеренные SVG из diagrams/svg.
#
# Использование:
#   ./render.sh            # всё
#   ./render.sh 03 05      # только файлы, в имени которых есть 03 или 05
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$DIR/src"
SVG="$DIR/svg"
PNG="$DIR/png"

command -v plantuml >/dev/null 2>&1 || {
  echo "plantuml не найден в PATH. Установите: brew install plantuml" >&2
  exit 1
}

mkdir -p "$SVG" "$PNG"
cd "$SRC"

FILES=""
for f in *.puml; do
  [ -e "$f" ] || continue
  if (($# > 0)); then
    for needle in "$@"; do
      case "$f" in
        *"$needle"*) FILES="$FILES $f"; break ;;
      esac
    done
  else
    FILES="$FILES $f"
  fi
done

if [ -z "${FILES// /}" ]; then
  echo "Нет .puml для рендера" >&2
  exit 1
fi

echo "Рендер:$FILES"
# shellcheck disable=SC2086
plantuml -tsvg -o "$SVG" $FILES
# shellcheck disable=SC2086
plantuml -tpng -o "$PNG" $FILES

echo "Готово:"
ls -1 "$SVG" | sed 's/^/  svg\//'
