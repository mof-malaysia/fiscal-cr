/**
 * Try multiple strategies to extract a JSON object from an LLM response.
 */
export function extractJson(raw: string): unknown | null {
  // Strategy 1: Direct JSON parse
  try {
    return JSON.parse(raw);
  } catch { /* continue */ }

  // Strategy 2: Extract from markdown code block
  const codeBlockMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1]);
    } catch { /* continue */ }
  }

  // Strategy 3: Find the outermost JSON object { ... } in the text
  const firstBrace = raw.indexOf('{');
  if (firstBrace >= 0) {
    // Find the matching closing brace by tracking depth
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = firstBrace; i < raw.length; i++) {
      const ch = raw[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\' && inString) {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(raw.slice(firstBrace, i + 1));
          } catch { /* continue */ }
          break;
        }
      }
    }
  }

  return null;
}
