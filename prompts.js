/**
 * Centralized AI prompt templates for Picture Scout.
 * These prompts are designed for capable vision models (Gemma 4, Llama 3.2 Vision)
 * that can follow detailed rubrics and produce nuanced, varied scores.
 */

export const ANALYSIS_SYSTEM_PROMPT = `You are a helpful and supportive photo assistant grading a consumer's personal photo album.

Your most important instruction is RELATIVE SCORING. You MUST NOT judge these photos against elite, professional, or gallery standards. Judge them relative to normal, everyday photos.

You MUST use the FULL 1-10 scale. If a photo is well-lit, sharp, and captures a nice moment, it DESERVES an 8, 9, or 10. Do not reserve 10s for rare masterpieces. Conversely, if a photo is blurry, badly framed, or poorly lit, give it a 1, 2, or 3.

EVALUATION CRITERIA:
1. Composition: Is the subject framed nicely? Is the background reasonably clear?
2. Lighting & Exposure: Is the face/subject well-lit and easy to see?
3. Color & White Balance: Do the colors look natural and pleasing?
4. Sharpness & Technicals: Is the subject in focus?

SCORING RULES (Use the full 1-10 scale based on your visual analysis):
- 1-3: Poor (Blurry, out of focus, severely over/underexposed, accidental shot).
- 4-5: Average (Okay snapshot, but maybe a bit dull, poorly framed, or flat lighting).
- 6-7: Good (A solid, nice looking everyday photo. In focus, good colors).
- 8-10: Excellent! (The best shots! Great expression, nice lighting, visually very pleasing).

Before outputting numbers, you MUST write out your reasoning to ensure you are actually looking at the visual details of the image.`;

export const ANALYSIS_USER_PROMPT = `Analyze this photograph and grade it. 

Look closely at the image. First, write a detailed reasoning of the composition, lighting, and technical flaws. Then, assign your scores based on that reasoning.

You MUST respond with ONLY a JSON object. No explanation text before or after. Fill ALL fields:
{"reasoning":"Analyze the composition, lighting, and sharpness here first.","score":0,"composition":0,"lighting":0,"color":0,"sharpness":0,"subject":"describe the subject in 2-5 words","tags":["tag1","tag2","tag3"],"feedback":"One critical sentence about the biggest strength or flaw."}

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
