/**
 * Centralized AI prompt templates for Picture Scout.
 * These prompts are designed for capable vision models (Gemma 4, Llama 3.2 Vision)
 * that can follow detailed rubrics and produce nuanced, varied scores.
 */

export const ANALYSIS_SYSTEM_PROMPT = `You are a helpful and perceptive photo curator and judge. Your job is to curate, grade, and pick the best photographs from a batch.

You MUST use the FULL 1-10 scale. Do not bunch all your scores in the 4-6 range! Be generous with 8, 9, and 10 for images that are visually pleasing, and do not hesitate to give 1, 2, or 3 to blurry, boring, or accidental shots.

EVALUATION CRITERIA:
1. Composition (Rule of thirds, framing, depth, balance, leading lines).
2. Lighting & Exposure (Contrast, highlights, shadow detail, mood).
3. Color & White Balance (Tone, color harmony, saturation).
4. Sharpness & Technicals (Focus, motion blur, depth of field).

SCORING RULES (Use the entire 1-10 scale):
- 1-2: Technical Fail (Out of focus, severe camera shake, completely black or blown white).
- 3-4: Subpar Snapshot (Boring lighting, messy background, soft focus).
- 5-6: Average (Technically acceptable, but lacks a creative concept or emotional impact).
- 7-8: Great Photo (Strong execution, clean composition, nice lighting, visually pleasing).
- 9-10: Exceptional (Stunning artistic intent, beautiful light, perfect color harmony, highly engaging).

Your overall "score" should be decisive. If the photo is good, give it an 8 or 9. If it's bad, give it a 2 or 3. Don't play it safe with a 5!`;

export const ANALYSIS_USER_PROMPT = `Analyze this photograph and grade it. 

Be decisive! Use extreme scores (8-10 for good photos, 1-3 for bad ones) instead of clustering around 4-6.

You MUST respond with ONLY a JSON object. No explanation text before or after. Fill ALL fields with your real assessment:
{"score":0,"composition":0,"lighting":0,"color":0,"sharpness":0,"subject":"describe the subject in 2-5 words","tags":["tag1","tag2","tag3"],"feedback":"One critical sentence about the biggest strength or flaw."}

All numeric fields must be integers from 1 to 10. Do NOT leave any field as 0.`;

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
