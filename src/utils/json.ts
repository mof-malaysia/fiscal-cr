/**
 * Try multiple strategies to extract a JSON object from an LLM response.
 *
 * By default the final strategy repairs a response truncated mid-generation
 * (the model hit its output-token cap). Pass `{ repairTruncated: false }` to
 * reject truncated input instead — used by callers that must treat a payload
 * as an all-or-nothing unit (e.g. a change-diagram graph).
 */
export interface ExtractJsonOptions {
  repairTruncated?: boolean;
}

export function extractJson(raw: string, opts: ExtractJsonOptions = {}): unknown | null {
  const { repairTruncated = true } = opts;

  // Strategy 1: Direct JSON parse of the whole input.
  try {
    return JSON.parse(raw);
  } catch { /* continue */ }

  // Strategy 2: Extract from a markdown code block.
  const codeBlockMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1]);
    } catch {
      // A fenced block whose body is not valid JSON is a broken envelope. In
      // no-repair mode we must not fall through and probe for a fragment
      // nested inside it — reject outright.
      if (!repairTruncated) return null;
    }
  }

  // Strategy 3: Find the outermost JSON object { ... } in the text.
  const firstBrace = raw.indexOf('{');
  if (firstBrace >= 0) {
    // In no-repair mode an outer container opener ([ or {) at the start of the
    // (trimmed) content means the payload was a JSON container that is itself
    // malformed/truncated. Accepting an object nested inside such a container
    // would let a truncated envelope smuggle in an otherwise-valid object, so
    // reject before probing for an inner fragment.
    if (!repairTruncated) {
      const lead = raw.trimStart()[0];
      if (lead === '[' || lead === '{') return null;
    }

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
  if (!repairTruncated) return null;
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
