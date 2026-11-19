/**
 * D1-FE1: rail/switcher avatars use one letter, matching design/dashboard v1.2.
 * For "Студия «Восход»" the meaningful word is "Восход" → "В"; for "Семья" → "С".
 */
export function workspaceInitial(name: string): string {
  const words = name
    .replace(/[«»"'`]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const source = words.length > 0 ? words[words.length - 1]! : name;
  const letter = Array.from(source).find((character) => /[\p{L}\p{N}]/u.test(character));
  return (letter ?? '?').toLocaleUpperCase('ru-RU');
}
