/**
 * Centralized AI prompt templates for Picture Scout.
 * These prompts are sent to Gemma 4 / Moondream via Ollama for image analysis.
 */

export const ANALYSIS_SYSTEM_PROMPT = `You are a highly critical, elite professional photographer, chief photo editor, and contest judge. Your job is to curate, grade, and pick only the absolute best photographs.

You must judge photographs with extreme scrutiny and strict professional standards. You MUST NOT give similar scores to every image. A successful professional curation requires a clear hierarchy—separate average snapshots from masterpieces.

CRITICAL EVALUATION CRITERIA:
1. Composition (Rule of thirds, framing, depth, balance, leading lines, distractions).
   - Deduct heavily for centered subjects without artistic reason, cut-off body parts/limbs, distracting objects in backgrounds, tilted horizons, or flat framing.
2. Lighting & Exposure (Contrast, highlights, shadow detail, light direction, dynamic range, mood).
   - Deduct heavily for flat, boring overcast lighting, harsh overexposed highlights (blown skies/skin), muddy shadows with zero detail, or direct unartistic flash.
3. Color & White Balance (Tone, color harmony, saturation, color grading, skin tones).
   - Deduct heavily for sickly green/orange white balance casts, oversaturated garish tones, muddy/flat color palettes, or mismatched background tones.
4. Sharpness & Technicals (Misfocus, motion blur, depth of field, noise, digital artifacts).
   - Misfocused subjects, soft details, or severe motion blur MUST result in an immediate automatic Technical Score of 1-3. No exceptions.

SCORING RULES (Use the entire 1-10 scale strictly):
- 1-2 (Technical Fail): Out of focus, severe camera shake, accidental framing, completely black or blown white.
- 3-4 (Subpar / Amateur Snapshot): Tilted horizon, flat boring lighting, messy background clutter, soft focus.
- 5-6 (Average / Competent): Technically acceptable, sharp, and properly exposed, but lacks a creative concept, unique angle, or emotional impact. Typical of everyday travel snaps or raw phone snapshots.
- 7 (Professional Entry): Strong execution, clean composition, nice lighting, clear visual story, minor flaws.
- 8-9 (Exceptional Portfolio Grade): Stunning artistic intent, beautiful golden hour or high-contrast studio light, perfect color harmony, instantly holds the viewer's attention.
- 10 (Masterpiece): Gallery-level work. Flawless execution, extraordinary rare timing, immense emotional power. (Reserve this for less than 1% of images).

Your overall "score" should reflect this strict curation philosophy—do not mathematically average the categories. A technically sharp snap with bad composition is still a subpar photo (3-4).`;

export const ANALYSIS_USER_PROMPT = `As an elite photography judge, analyze this photograph with strict professional standards. 

Identify clear flaws in composition, lighting, focus, or color. If it looks like a standard snapshot with no creative concept, grade it strictly as a 5 or lower. If there is clear technical failure (motion blur, soft focus), fail it as a 3 or lower. Only give 7+ to outstanding artistic achievements.

Format your response in JSON exactly like this example, filling out ALL fields completely:
{
  "score": 4,
  "composition": 3,
  "lighting": 5,
  "color": 5,
  "sharpness": 2,
  "subject": "Soft-focus candid of people walking",
  "tags": ["street", "candid", "fail"],
  "feedback": "The primary subject is noticeably out of focus, and the background contains multiple distracting pedestrians that clutter the frame."
}`;

/**
 * Parse the AI response, handling potential quirks in model output.
 * @param {string} raw - Raw text from the model
 * @returns {object|null} Parsed analysis or null on failure
 */
export function parseAnalysisResponse(raw) {
  if (!raw || typeof raw !== 'string') return null;

  // Strip markdown code fences if present
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  cleaned = cleaned.trim();

  // Try to extract JSON object from the response
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  const jsonStr = jsonMatch ? jsonMatch[0] : cleaned;

  let parsed = null;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    // Regex fallback parsing for resilient extraction of keys
    console.warn("[Parser Warning] JSON.parse failed. Attempting resilient regex extraction...");
    parsed = {};
    
    const extractNum = (key) => {
      const regex = new RegExp(`['"]${key}['"]\\s*:\\s*([0-9.]+)`, 'i');
      const m = jsonStr.match(regex);
      return m ? parseFloat(m[1]) : null;
    };

    const extractStr = (key) => {
      // Match text between double or single quotes after the key
      const regex = new RegExp(`['"]${key}['"]\\s*:\\s*["']([^"']*)["']`, 'i');
      const m = jsonStr.match(regex);
      if (m) return m[1];
      
      // Try matching unquoted single-line if double/single quotes failed
      const regexFallback = new RegExp(`['"]${key}['"]\\s*:\\s*([^,}\\n]+)`, 'i');
      const m2 = jsonStr.match(regexFallback);
      return m2 ? m2[1].trim() : '';
    };

    const extractTags = () => {
      const regex = /"tags"\s*:\s*\[([\s\S]*?)\]/i;
      const m = jsonStr.match(regex);
      if (!m) return [];
      return m[1]
        .split(',')
        .map(t => t.replace(/["'\s]/g, '').trim())
        .filter(t => t && t !== '...' && t !== '<string>');
    };

    parsed.score = extractNum('score');
    parsed.composition = extractNum('composition');
    parsed.lighting = extractNum('lighting');
    parsed.color = extractNum('color');
    parsed.sharpness = extractNum('sharpness');
    parsed.subject = extractStr('subject');
    parsed.feedback = extractStr('feedback');
    parsed.tags = extractTags();
  }

  // Validate and clamp scores (handling floats/10-scale conversions)
  const clamp = (v) => {
    let num = Number(v);
    if (isNaN(num)) return 5;
    if (num > 0 && num <= 1) num = num * 10; // Convert 0.8 to 8
    return Math.max(1, Math.min(10, Math.round(num)));
  };

  // Ensure we got at least some numeric scores, otherwise return null
  if (parsed.score === null && parsed.composition === null) {
    return null;
  }

  return {
    score: clamp(parsed.score ?? 5),
    composition: clamp(parsed.composition ?? 5),
    lighting: clamp(parsed.lighting ?? 5),
    color: clamp(parsed.color ?? 5),
    sharpness: clamp(parsed.sharpness ?? 5),
    subject: String(parsed.subject || 'Unknown').replace(/\\"/g, '"').slice(0, 100) || 'Unknown',
    tags: Array.isArray(parsed.tags)
      ? parsed.tags.map(t => String(t).slice(0, 30)).slice(0, 8)
      : [],
    feedback: String(parsed.feedback || 'Photo analyzed.').replace(/\\"/g, '"').slice(0, 500) || 'Photo analyzed.',
  };
}
