/**
 * Centralized AI prompt templates for Picture Scout.
 * Designed to work with lightweight vision models (Moondream, etc.) as well as
 * larger models (Llama 3.2 Vision, Gemma 4).
 *
 * Key design decisions:
 * - No system prompt (small models ignore or mishandle them).
 * - Single concise user prompt with the image.
 * - JSON example uses EMPTY placeholder values so the model doesn't parrot them.
 * - Scoring guidance is brief and embedded directly in the user message.
 */

// Small models tend to ignore system prompts entirely, so we keep it minimal.
// The real instructions go into the user prompt alongside the image.
export const ANALYSIS_SYSTEM_PROMPT = `You are a professional photography judge. Respond ONLY with a JSON object.`;

export const ANALYSIS_USER_PROMPT = `Rate this photograph as a strict professional photography judge.

SCORING GUIDE (1-10 scale):
- 1-2: Blurry, out of focus, or technically broken
- 3-4: Poor composition, bad lighting, amateur snapshot
- 5-6: Average photo, acceptable but uninteresting
- 7-8: Good photo with strong composition and lighting
- 9-10: Exceptional, portfolio-worthy photograph

Be critical. Most everyday photos deserve 3-6. Only truly impressive shots get 7+.

Respond with ONLY this JSON (fill in real values, no placeholders):
{"score":0,"composition":0,"lighting":0,"color":0,"sharpness":0,"subject":"","tags":[],"feedback":""}

Rules for the JSON:
- score/composition/lighting/color/sharpness: integers 1 to 10
- subject: brief 2-5 word description of what is in the photo
- tags: 2-4 short lowercase tags
- feedback: one sentence about the biggest strength or weakness`;

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
    if (isNaN(num)) return null; // Return null instead of defaulting to 5
    if (num > 0 && num <= 1) num = num * 10; // Convert 0.8 to 8
    return Math.max(1, Math.min(10, Math.round(num)));
  };

  // Ensure we got at least some numeric scores, otherwise return null
  if (parsed.score === null && parsed.composition === null) {
    return null;
  }

  // Compute a derived overall score if individual category scores exist but overall is missing/zero
  const clamped = {
    composition: clamp(parsed.composition),
    lighting: clamp(parsed.lighting),
    color: clamp(parsed.color),
    sharpness: clamp(parsed.sharpness),
  };

  let overallScore = clamp(parsed.score);

  // If the model returned 0 or null for overall score but gave category scores, derive it
  if (!overallScore || overallScore === 0) {
    const catScores = Object.values(clamped).filter(v => v !== null);
    if (catScores.length > 0) {
      overallScore = Math.round(catScores.reduce((a, b) => a + b, 0) / catScores.length);
    } else {
      overallScore = 5;
    }
  }

  return {
    score: overallScore,
    composition: clamped.composition ?? overallScore,
    lighting: clamped.lighting ?? overallScore,
    color: clamped.color ?? overallScore,
    sharpness: clamped.sharpness ?? overallScore,
    subject: String(parsed.subject || 'Unknown').replace(/\\"/g, '"').slice(0, 100) || 'Unknown',
    tags: Array.isArray(parsed.tags)
      ? parsed.tags.map(t => String(t).slice(0, 30)).slice(0, 8)
      : [],
    feedback: String(parsed.feedback || 'Photo analyzed.').replace(/\\"/g, '"').slice(0, 500) || 'Photo analyzed.',
  };
}
