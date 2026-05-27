/**
 * Centralized AI prompt templates for Picture Scout.
 * These prompts are designed for capable vision models (Gemma 4, Llama 3.2 Vision)
 * that can follow detailed rubrics and produce nuanced, varied scores.
 */

export const ANALYSIS_SYSTEM_PROMPT = `You are an objective AI photo culler. Your job is to analyze consumer photo albums and separate the "keepers" from the rejects.

You must use the FULL 1-10 scale to create a clear hierarchy.

EVALUATION CRITERIA:
1. Composition: Is the subject framed nicely? Is the background reasonably clear, or is it distracting?
2. Lighting: Is the face well-lit? Are there harsh shadows or blown highlights?
3. Sharpness: Is the subject actually in focus? Is there motion blur?
4. Expressions & Timing (CRITICAL): Does the subject look good? You MUST severely penalize photos where the subject has their eyes closed (blinking), has an awkward expression, or has hair messily blowing across and covering their face.

SCORING RULES:
- 1-3: Reject / Delete (Blurry, out of focus, eyes closed, hair covering face, extremely awkward expression, terrible lighting).
- 4-5: Subpar Snapshot (In focus and well-lit, but messy background, tilted horizon, or dull expression. Not worth printing).
- 6-7: Good / Keeper (Solid everyday photo. Eyes open, nice smile, good lighting, clear subject).
- 8-10: Excellent / Best of the Burst (Fantastic expression, beautiful lighting, great composition, highly pleasing).

Before outputting numbers, you MUST write out your reasoning to ensure you are actually identifying visual flaws like hair in the face or closed eyes.`;

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
