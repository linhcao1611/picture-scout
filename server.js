import express from 'express';
import { readdir, stat, readFile, writeFile, unlink, access } from 'node:fs/promises';
import { join, extname, basename, resolve } from 'node:path';
import { createReadStream } from 'node:fs';
import sharp from 'sharp';
import { GoogleAuth } from 'google-auth-library';
import { ANALYSIS_SYSTEM_PROMPT, ANALYSIS_USER_PROMPT, parseAnalysisResponse } from './prompts.js';

const app = express();
const PORT = 3000;
const OLLAMA_URL = 'http://localhost:11434';
const CACHE_FILENAME = '.picture-scout-cache.json';
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tiff', '.tif', '.avif', '.heic']);
const MAX_IMAGE_DIMENSION = 512; // Resize images before sending to AI

// Settings (in-memory, persisted on change)
let settings = {
  provider: 'lmstudio', // 'ollama' | 'lmstudio' | 'openai' | 'anthropic' | 'gemini'
  ollamaUrl: 'http://localhost:11434',
  lmStudioUrl: 'http://localhost:1234/v1',
  openaiKey: '',
  anthropicKey: '',
  geminiKey: '',
  model: 'gemma-4',
  thumbnailSize: 300,
};

/**
 * Detect the best available model, falling back if the configured model is missing.
 */
async function detectBestModel() {
  if (settings.provider === 'lmstudio') {
    try {
      const response = await fetch(`${settings.lmStudioUrl}/models`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) {
        const data = await response.json();
        const models = (data.data || []).map(m => m.id);
        
        if (models.length > 0 && !models.includes(settings.model)) {
          console.log(`[Model Auto-Detect] Configured LM Studio model "${settings.model}" not found. Auto-switching to "${models[0]}".`);
          settings.model = models[0];
        }
      }
    } catch (err) {
      // LM Studio not reachable, ignore
    }
  } else {
    // Ollama
    try {
      const response = await fetch(`${settings.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) {
        const data = await response.json();
        const models = (data.models || []).map(m => m.name);
        
        // If the current model isn't available, check for alternatives
        if (models.length > 0 && !models.includes(settings.model)) {
          // 1. Look for moondream:latest
          if (models.includes('moondream:latest')) {
            console.log(`[Model Auto-Detect] Configured model "${settings.model}" not found. Auto-switching to "moondream:latest".`);
            settings.model = 'moondream:latest';
          } 
          // 2. Look for any moondream model
          else {
            const moondreamModel = models.find(m => m.startsWith('moondream'));
            if (moondreamModel) {
              console.log(`[Model Auto-Detect] Configured model "${settings.model}" not found. Auto-switching to available moondream model "${moondreamModel}".`);
              settings.model = moondreamModel;
            }
            // 3. Look for llama3.2-vision
            else if (models.includes('llama3.2-vision')) {
              console.log(`[Model Auto-Detect] Configured model "${settings.model}" not found. Auto-switching to "llama3.2-vision".`);
              settings.model = 'llama3.2-vision';
            } 
            // 4. Look for any llama3.2-vision model
            else {
              const llamaVisionModel = models.find(m => m.startsWith('llama3.2-vision'));
              if (llamaVisionModel) {
                console.log(`[Model Auto-Detect] Configured model "${settings.model}" not found. Auto-switching to available llama3.2-vision model "${llamaVisionModel}".`);
                settings.model = llamaVisionModel;
              }
              // 5. Look for any non-embedding model
              else {
                const nonEmbedModel = models.find(m => !m.includes('embed'));
                if (nonEmbedModel) {
                  console.log(`[Model Auto-Detect] Configured model "${settings.model}" not found. Auto-switching to available model "${nonEmbedModel}".`);
                  settings.model = nonEmbedModel;
                }
              }
            }
          }
        }
      }
    } catch (err) {
      // Ollama not reachable, ignore
    }
  }
}


app.use(express.json());
app.use(express.static('public'));

app.use((req, res, next) => {
  console.log(`[Request] ${req.method} ${req.url}`);
  next();
});

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Check if a path is a valid image file based on extension.
 */
function isImageFile(filename) {
  return IMAGE_EXTENSIONS.has(extname(filename).toLowerCase());
}

/**
 * Get file metadata for an image.
 */
async function getImageInfo(filePath) {
  try {
    const stats = await stat(filePath);
    return {
      path: filePath,
      filename: basename(filePath),
      size: stats.size,
      modified: stats.mtime.toISOString(),
    };
  } catch {
    return null;
  }
}

/**
 * Read and resize an image to base64 for the AI model.
 */
async function imageToBase64(filePath) {
  const buffer = await readFile(filePath);
  const resized = await sharp(buffer)
    .rotate() // Auto-rotate based on EXIF orientation metadata
    .resize(MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
  return resized.toString('base64');
}

/**
 * Read the cache file from a folder.
 */
async function readCache(folder) {
  const cachePath = join(folder, CACHE_FILENAME);
  try {
    const data = await readFile(cachePath, 'utf-8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

/**
 * Write analysis results to the cache file.
 */
async function writeCache(folder, cache) {
  const cachePath = join(folder, CACHE_FILENAME);
  await writeFile(cachePath, JSON.stringify(cache, null, 2), 'utf-8');
}

/**
 * Send an image to Ollama for analysis.
 */
async function analyzeWithOllama(base64Image, model) {
  console.log(`[Ollama] Sending image to Ollama using model "${model}"...`);
  const startTime = Date.now();
  
  const response = await fetch(`${settings.ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model,
      messages: [
        { role: 'system', content: ANALYSIS_SYSTEM_PROMPT },
        { role: 'user', content: ANALYSIS_USER_PROMPT, images: [base64Image] },
      ],
      stream: false,
      options: {
        temperature: 0.3,
        num_predict: 2048,
        num_ctx: 2048,
      },
    }),
  });

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[Ollama] Received response from Ollama. Status: ${response.status} (${duration}s)`);

  if (!response.ok) {
    const errText = await response.text();
    console.error(`[Ollama] Request failed with status ${response.status}:`, errText);
    throw new Error(`Ollama error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const rawContent = data.message?.content || '';
  
  console.log(`[Ollama] Raw content received (length: ${rawContent.length}). Parsing content...`);
  const analysis = parseAnalysisResponse(rawContent);

  if (!analysis) {
    console.error(`[Ollama Response Parse Failure] Raw Content: "${rawContent}"`);
    throw new Error(`Failed to parse AI response: ${rawContent.slice(0, 200)}`);
  }

  console.log(`[Ollama] Successfully parsed analysis. Overall Score: ${analysis.score}`);
  return analysis;
}

/**
 * Send an image to LM Studio (OpenAI-compatible) for analysis.
 */
async function analyzeWithLMStudio(base64Image, model) {
  console.log(`[LM Studio] Sending image to LM Studio using model "${model}"...`);
  const startTime = Date.now();
  
  const response = await fetch(`${settings.lmStudioUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model,
      messages: [
        { role: 'system', content: ANALYSIS_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: ANALYSIS_USER_PROMPT },
            {
              type: 'image_url',
              image_url: {
                url: `data:image/jpeg;base64,${base64Image}`
              }
            }
          ]
        }
      ],
      temperature: 0.3,
      max_tokens: 2048,
    }),
  });

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[LM Studio] Received response from LM Studio. Status: ${response.status} (${duration}s)`);

  if (!response.ok) {
    const errText = await response.text();
    console.error(`[LM Studio] Request failed with status ${response.status}:`, errText);
    throw new Error(`LM Studio error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const rawContent = data.choices?.[0]?.message?.content || '';
  
  console.log(`[LM Studio] Raw content received (length: ${rawContent.length}). Parsing content...`);
  const analysis = parseAnalysisResponse(rawContent);

  if (!analysis) {
    console.error(`[LM Studio Response Parse Failure] Raw Content: "${rawContent}"`);
    throw new Error(`Failed to parse AI response: ${rawContent.slice(0, 200)}`);
  }

  console.log(`[LM Studio] Successfully parsed analysis. Overall Score: ${analysis.score}`);
  return analysis;
}

/**
 * Send an image to OpenAI for analysis.
 */
async function analyzeWithOpenAI(base64Image, model) {
  if (!settings.openaiKey) throw new Error("OpenAI API key is required");
  console.log(`[OpenAI] Sending image using model "${model}"...`);
  const startTime = Date.now();
  
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${settings.openaiKey}`
    },
    body: JSON.stringify({
      model: model,
      messages: [
        { role: 'system', content: ANALYSIS_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: ANALYSIS_USER_PROMPT },
            {
              type: 'image_url',
              image_url: { url: `data:image/jpeg;base64,${base64Image}` }
            }
          ]
        }
      ],
      temperature: 0.3,
      max_tokens: 2048,
    }),
  });

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[OpenAI] Status: ${response.status} (${duration}s)`);

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const rawContent = data.choices?.[0]?.message?.content || '';
  const analysis = parseAnalysisResponse(rawContent);

  if (!analysis) throw new Error(`Failed to parse AI response: ${rawContent.slice(0, 200)}`);
  return analysis;
}

/**
 * Send an image to Anthropic for analysis.
 */
async function analyzeWithAnthropic(base64Image, model) {
  if (!settings.anthropicKey) throw new Error("Anthropic API key is required");
  console.log(`[Anthropic] Sending image using model "${model}"...`);
  const startTime = Date.now();
  
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': settings.anthropicKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: model,
      system: ANALYSIS_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/jpeg', data: base64Image }
            },
            { type: 'text', text: ANALYSIS_USER_PROMPT }
          ]
        }
      ],
      temperature: 0.3,
      max_tokens: 2048,
    }),
  });

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[Anthropic] Status: ${response.status} (${duration}s)`);

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Anthropic error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const rawContent = data.content?.[0]?.text || '';
  const analysis = parseAnalysisResponse(rawContent);

  if (!analysis) throw new Error(`Failed to parse AI response: ${rawContent.slice(0, 200)}`);
  return analysis;
}

/**
 * Send an image to Google Gemini for analysis.
 * Uses API key if provided, otherwise falls back to Application Default Credentials.
 */
async function analyzeWithGemini(base64Image, model) {
  if (!settings.geminiKey) throw new Error("Google Gemini API key is required");
  console.log(`[Gemini] Sending image using model "${model}"...`);
  const startTime = Date.now();
  
  let url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${settings.geminiKey}`;
  let headers = { 'Content-Type': 'application/json' };
  
  const response = await fetch(url, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify({
      system_instruction: { parts: [{ text: ANALYSIS_SYSTEM_PROMPT }] },
      contents: [
        {
          role: 'user',
          parts: [
            { text: ANALYSIS_USER_PROMPT },
            {
              inline_data: { mime_type: 'image/jpeg', data: base64Image }
            }
          ]
        }
      ],
      generationConfig: { temperature: 0.3 }
    }),
  });

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[Gemini] Status: ${response.status} (${duration}s)`);

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const rawContent = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const analysis = parseAnalysisResponse(rawContent);

  if (!analysis) throw new Error(`Failed to parse AI response: ${rawContent.slice(0, 200)}`);
  return analysis;
}

/**
 * Dispatch analysis based on configured provider.
 */
async function analyzeWithAI(base64Image, provider, model) {
  switch (provider) {
    case 'lmstudio': return analyzeWithLMStudio(base64Image, model);
    case 'openai': return analyzeWithOpenAI(base64Image, model);
    case 'anthropic': return analyzeWithAnthropic(base64Image, model);
    case 'gemini': return analyzeWithGemini(base64Image, model);
    case 'ollama':
    default:
      return analyzeWithOllama(base64Image, model);
  }
}

// ─── API Routes ────────────────────────────────────────────────────────────────

/**
 * POST /api/scan
 * Scan a folder for image files and return their metadata.
 * Also loads cached analysis results if available.
 */
app.post('/api/scan', async (req, res) => {
  try {
    const { folder } = req.body;
    if (!folder) {
      return res.status(400).json({ error: 'Folder path is required' });
    }

    const resolvedFolder = resolve(folder);

    // Verify folder exists
    try {
      const folderStat = await stat(resolvedFolder);
      if (!folderStat.isDirectory()) {
        return res.status(400).json({ error: 'Path is not a directory' });
      }
    } catch {
      return res.status(400).json({ error: 'Folder not found' });
    }

    // Read directory entries
    const entries = await readdir(resolvedFolder);
    const imageFiles = entries.filter(isImageFile);

    // Get metadata for each image
    const images = [];
    for (const file of imageFiles) {
      const info = await getImageInfo(join(resolvedFolder, file));
      if (info) images.push(info);
    }

    // Sort by filename by default
    images.sort((a, b) => a.filename.localeCompare(b.filename));

    // Load cached analysis results
    const cache = await readCache(resolvedFolder);

    // Merge cached results into images
    for (const img of images) {
      if (cache[img.filename]) {
        img.analysis = cache[img.filename];
      }
    }

    res.json({
      folder: resolvedFolder,
      count: images.length,
      images,
    });
  } catch (err) {
    console.error('Scan error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/analyze
 * Analyze a single image with Gemma 4.
 */
app.post('/api/analyze', async (req, res) => {
  try {
    const { path: imagePath } = req.body;
    if (!imagePath) {
      return res.status(400).json({ error: 'Image path is required' });
    }

    const resolvedPath = resolve(imagePath);

    // Verify the file exists
    try {
      await access(resolvedPath);
    } catch {
      return res.status(404).json({ error: 'Image file not found' });
    }

    // Convert to base64 and analyze
    const base64 = await imageToBase64(resolvedPath);
    const analysis = await analyzeWithAI(base64, settings.provider, settings.model);

    // Cache the result
    const folder = resolve(resolvedPath, '..');
    const cache = await readCache(folder);
    cache[basename(resolvedPath)] = analysis;
    await writeCache(folder, cache);

    res.json({
      path: resolvedPath,
      filename: basename(resolvedPath),
      analysis,
    });
  } catch (err) {
    console.error('Analyze error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/analyze-all
 * Batch-analyze all images in a folder using Server-Sent Events for progress.
 */
app.get('/api/analyze-all', async (req, res) => {
  const folder = req.query.folder;
  if (!folder) {
    return res.status(400).json({ error: 'Folder query parameter is required' });
  }

  const resolvedFolder = resolve(folder);

  // Set up SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    // Get all image files
    const entries = await readdir(resolvedFolder);
    const imageFiles = entries.filter(isImageFile);
    const total = imageFiles.length;

    if (total === 0) {
      send({ type: 'done', total: 0, analyzed: 0 });
      res.end();
      return;
    }

    // Load existing cache
    const cache = await readCache(resolvedFolder);
    let analyzed = 0;
    let skipped = 0;

    send({ type: 'start', total });

    for (const file of imageFiles) {
      const filePath = join(resolvedFolder, file);

      // Skip already-analyzed files
      if (cache[file]) {
        skipped++;
        analyzed++;
        send({
          type: 'result',
          path: filePath,
          filename: file,
          analysis: cache[file],
          cached: true,
          progress: analyzed,
          total,
        });
        continue;
      }

      try {
        send({ type: 'progress', filename: file, progress: analyzed, total, status: 'analyzing' });

        const base64 = await imageToBase64(filePath);
        
        let analysis;
        let retries = 3;
        let delay = 2000;
        
        while (retries >= 0) {
          try {
            analysis = await analyzeWithAI(base64, settings.provider, settings.model);
            break; // Success
          } catch (err) {
            // Check if error is a rate limit (429) or server error (503)
            if (retries > 0 && (err.message.includes('(429)') || err.message.includes('(503)') || err.message.includes('429 Too Many Requests'))) {
              console.log(`[Rate Limit] Hit limit, retrying in ${delay/1000}s... (${retries} retries left)`);
              send({ type: 'progress', filename: file, progress: analyzed, total, status: 'rate limited, waiting...' });
              await new Promise(r => setTimeout(r, delay));
              delay *= 2; // Exponential backoff
              retries--;
            } else {
              throw err;
            }
          }
        }

        // Cache immediately
        cache[file] = analysis;
        await writeCache(resolvedFolder, cache);

        analyzed++;
        send({
          type: 'result',
          path: filePath,
          filename: file,
          analysis,
          cached: false,
          progress: analyzed,
          total,
        });
      } catch (err) {
        analyzed++;
        send({
          type: 'error',
          filename: file,
          message: err.message,
          progress: analyzed,
          total,
        });
      }
    }

    send({ type: 'done', total, analyzed, skipped });
  } catch (err) {
    send({ type: 'error', message: err.message });
  }

  res.end();
});

/**
 * GET /api/images
 * Serve a local image file, optionally as a thumbnail.
 */
app.get('/api/images', async (req, res) => {
  try {
    const imagePath = req.query.path;
    const thumb = req.query.thumb === '1';

    if (!imagePath) {
      return res.status(400).json({ error: 'Path query parameter is required' });
    }

    const resolvedPath = resolve(imagePath);

    // Verify file exists
    try {
      await access(resolvedPath);
    } catch {
      return res.status(404).json({ error: 'Image not found' });
    }

    if (thumb) {
      // Serve a resized, rotated thumbnail
      const thumbBuffer = await sharp(resolvedPath)
        .rotate() // Auto-rotate based on EXIF orientation metadata
        .resize(settings.thumbnailSize, settings.thumbnailSize, { fit: 'cover' })
        .jpeg({ quality: 75 })
        .toBuffer();

      res.set('Content-Type', 'image/jpeg');
      res.set('Cache-Control', 'public, max-age=86400');
      res.send(thumbBuffer);
    } else {
      // Serve a rotated and optimized preview image (max 1600px for screen viewing)
      const ext = extname(resolvedPath).toLowerCase();
      if (IMAGE_EXTENSIONS.has(ext)) {
        try {
          const previewBuffer = await sharp(resolvedPath)
            .rotate() // Auto-rotate based on EXIF orientation metadata
            .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 85 })
            .toBuffer();

          res.set('Content-Type', 'image/jpeg');
          res.set('Cache-Control', 'public, max-age=86400');
          res.send(previewBuffer);
          return;
        } catch (sharpErr) {
          console.warn('[Sharp Preview Error] Failed to process preview with sharp, falling back to raw stream:', sharpErr);
        }
      }

      // Serve original file raw if it's not a standard image or sharp failed
      const mimeTypes = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.webp': 'image/webp',
        '.gif': 'image/gif',
        '.bmp': 'image/bmp',
        '.tiff': 'image/tiff',
        '.tif': 'image/tiff',
        '.avif': 'image/avif',
        '.heic': 'image/heic',
      };

      res.set('Content-Type', mimeTypes[ext] || 'application/octet-stream');
      res.set('Cache-Control', 'public, max-age=86400');
      createReadStream(resolvedPath).pipe(res);
    }
  } catch (err) {
    console.error('Image serve error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/settings
 * Return current settings and local AI connection status.
 */
app.get('/api/settings', async (_req, res) => {
  let aiOnline = false;
  let availableModels = [];

  if (settings.provider === 'lmstudio') {
    try {
      const response = await fetch(`${settings.lmStudioUrl}/models`, { signal: AbortSignal.timeout(3000) });
      if (response.ok) {
        aiOnline = true;
        const data = await response.json();
        availableModels = (data.data || []).map(m => m.id);
        
        // Auto-detect and align configured model with what is actually available in LM Studio
        if (availableModels.length > 0 && !availableModels.includes(settings.model)) {
          settings.model = availableModels[0];
        }
      }
    } catch {
      // LM Studio not reachable
    }
  } else if (settings.provider === 'ollama') {
    // Ollama
    try {
      const response = await fetch(`${settings.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (response.ok) {
        aiOnline = true;
        const data = await response.json();
        availableModels = (data.models || []).map(m => m.name);
        
        // Auto-detect and align configured model with what is actually available in Ollama
        if (availableModels.length > 0 && !availableModels.includes(settings.model)) {
          if (availableModels.includes('moondream:latest')) {
            settings.model = 'moondream:latest';
          } else {
            const moondreamModel = availableModels.find(m => m.startsWith('moondream'));
            if (moondreamModel) {
              settings.model = moondreamModel;
            } else if (availableModels.includes('llama3.2-vision')) {
              settings.model = 'llama3.2-vision';
            } else {
              const llamaVisionModel = availableModels.find(m => m.startsWith('llama3.2-vision'));
              if (llamaVisionModel) {
                settings.model = llamaVisionModel;
              } else {
                const nonEmbedModel = availableModels.find(m => !m.includes('embed'));
                if (nonEmbedModel) {
                  settings.model = nonEmbedModel;
                }
              }
            }
          }
        }
      }
    } catch {
      // Ollama not reachable
    }
  } else {
    // Cloud Providers (OpenAI, Anthropic, Gemini)
    aiOnline = true;
  }

  res.json({
    ...settings,
    ollamaOnline: aiOnline, // maintain frontend variable name for seamless compatibility
    availableModels,
  });
});

/**
 * POST /api/settings
 * Update settings.
 */
app.post('/api/settings', (req, res) => {
  const { provider, ollamaUrl, lmStudioUrl, openaiKey, anthropicKey, geminiKey, model, thumbnailSize } = req.body;

  if (provider && typeof provider === 'string') settings.provider = provider;
  if (ollamaUrl && typeof ollamaUrl === 'string') settings.ollamaUrl = ollamaUrl;
  if (lmStudioUrl && typeof lmStudioUrl === 'string') settings.lmStudioUrl = lmStudioUrl;
  if (typeof openaiKey === 'string') settings.openaiKey = openaiKey;
  if (typeof anthropicKey === 'string') settings.anthropicKey = anthropicKey;
  if (typeof geminiKey === 'string') settings.geminiKey = geminiKey;
  if (model && typeof model === 'string') settings.model = model;
  
  if (thumbnailSize && typeof thumbnailSize === 'number' && thumbnailSize >= 100 && thumbnailSize <= 800) {
    settings.thumbnailSize = thumbnailSize;
  }

  res.json(settings);
});

/**
 * GET /api/cache
 * Read the cache for a given folder.
 */
app.get('/api/cache', async (req, res) => {
  try {
    const folder = req.query.folder;
    if (!folder) return res.status(400).json({ error: 'Folder is required' });

    const cache = await readCache(resolve(folder));
    res.json(cache);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/cache
 * Clear the cache for a given folder.
 */
app.delete('/api/cache', async (req, res) => {
  try {
    const folder = req.query.folder;
    if (!folder) return res.status(400).json({ error: 'Folder is required' });

    const cachePath = join(resolve(folder), CACHE_FILENAME);
    try {
      await unlink(cachePath);
    } catch {
      // Cache file didn't exist, that's fine
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start Server ──────────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  await detectBestModel();
  const providerLabels = {
    lmstudio: 'LM Studio',
    ollama: 'Ollama',
    openai: 'OpenAI',
    anthropic: 'Anthropic',
    gemini: 'Google Gemini'
  };
  const providerLabel = providerLabels[settings.provider] || 'Ollama';
  let providerUrl = '';
  if (settings.provider === 'lmstudio') providerUrl = settings.lmStudioUrl;
  else if (settings.provider === 'ollama') providerUrl = settings.ollamaUrl;
  else providerUrl = 'Cloud API';
  
  console.log('');
  console.log('  ┌──────────────────────────────────────────┐');
  console.log('  │                                          │');
  console.log('  │   📸  Picture Scout                      │');
  console.log('  │   AI-Powered Photo Curation              │');
  console.log('  │                                          │');
  console.log(`  │   Local:    http://localhost:${PORT}          │`);
  console.log(`  │   Provider: ${providerLabel.padEnd(27)}│`);
  console.log(`  │   Endpoint: ${providerUrl.slice(0, 27).padEnd(27)}│`);
  console.log(`  │   Model:    ${settings.model.slice(0, 27).padEnd(27)}│`);
  console.log('  │                                          │');
  console.log('  └──────────────────────────────────────────┘');
  console.log('');
});
// Trigger reload after prioritizing moondream
