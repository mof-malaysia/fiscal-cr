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

  // Strategy 4: Repair a truncated object (response cut off at the token cap).
  return repairTruncatedJson(raw);
}

/**
 * Best-effort recovery of a JSON object that was cut off mid-generation
 * (e.g. the model hit its output-token cap). Rewinds to the last point where
 * the structure was at a value boundary — after a closing `}`/`]`, or just
 * before a `,` — drops the incomplete trailing token, and closes every still-
 * open array/object. This preserves the elements that were fully emitted (e.g.
 * the complete findings before truncation) and discards the partial last one.
 * Returns null when nothing salvageable precedes the truncation point.
 */
export function repairTruncatedJson(raw: string): unknown | null {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  const text = raw.slice(start);

  const stack: Array<'{' | '['> = [];
  let inString = false;
  let escape = false;
  // Furthest offset we can safely cut at, plus the open-container stack there.
  let cut = -1;
  let cutStack: Array<'{' | '['> = [];
  const mark = (end: number): void => {
    cut = end;
    cutStack = stack.slice();
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') {
      stack.pop();
      mark(i + 1); // a container just closed — clean boundary after it
    } else if (ch === ',') {
      mark(i); // the value before the comma is complete — cut before it
    }
  }

  if (cut <= 0) return null;

  let repaired = text.slice(0, cut);
  for (let i = cutStack.length - 1; i >= 0; i--) {
    repaired += cutStack[i] === '{' ? '}' : ']';
  }

  try {
    return JSON.parse(repaired);
  } catch {
    return null;
  }
}
