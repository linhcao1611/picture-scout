import express from 'express';
import { readdir, stat, readFile, writeFile, unlink, access } from 'node:fs/promises';
import { join, extname, basename, resolve } from 'node:path';
import { createReadStream } from 'node:fs';
import sharp from 'sharp';
import { ANALYSIS_SYSTEM_PROMPT, ANALYSIS_USER_PROMPT, parseAnalysisResponse } from './prompts.js';

const app = express();
const PORT = 3000;
const OLLAMA_URL = 'http://localhost:11434';
const CACHE_FILENAME = '.picture-scout-cache.json';
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tiff', '.tif', '.avif', '.heic']);
const MAX_IMAGE_DIMENSION = 512; // Resize images before sending to AI

// Settings (in-memory, persisted on change)
let settings = {
  model: 'gemma4:e4b',
  thumbnailSize: 300,
};

app.use(express.json());
app.use(express.static('public'));

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
  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
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
      },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Ollama error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const rawContent = data.message?.content || '';
  const analysis = parseAnalysisResponse(rawContent);

  if (!analysis) {
    console.error(`[Ollama Response Parse Failure] Raw Content: "${rawContent}"`);
    throw new Error(`Failed to parse AI response: ${rawContent.slice(0, 200)}`);
  }

  return analysis;
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
    const analysis = await analyzeWithOllama(base64, settings.model);

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
        const analysis = await analyzeWithOllama(base64, settings.model);

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
      // Serve a resized thumbnail
      const thumbBuffer = await sharp(resolvedPath)
        .resize(settings.thumbnailSize, settings.thumbnailSize, { fit: 'cover' })
        .jpeg({ quality: 75 })
        .toBuffer();

      res.set('Content-Type', 'image/jpeg');
      res.set('Cache-Control', 'public, max-age=86400');
      res.send(thumbBuffer);
    } else {
      // Serve original file
      const ext = extname(resolvedPath).toLowerCase();
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
 * Return current settings and Ollama connection status.
 */
app.get('/api/settings', async (_req, res) => {
  let ollamaOnline = false;
  let availableModels = [];

  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (response.ok) {
      ollamaOnline = true;
      const data = await response.json();
      availableModels = (data.models || []).map(m => m.name);
    }
  } catch {
    // Ollama not reachable
  }

  res.json({
    ...settings,
    ollamaOnline,
    availableModels,
  });
});

/**
 * POST /api/settings
 * Update settings.
 */
app.post('/api/settings', (req, res) => {
  const { model, thumbnailSize } = req.body;

  if (model && typeof model === 'string') {
    settings.model = model;
  }
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

app.listen(PORT, () => {
  console.log('');
  console.log('  ┌──────────────────────────────────────────┐');
  console.log('  │                                          │');
  console.log('  │   📸  Picture Scout                      │');
  console.log('  │   AI-Powered Photo Curation              │');
  console.log('  │                                          │');
  console.log(`  │   Local:  http://localhost:${PORT}            │`);
  console.log(`  │   Ollama: ${OLLAMA_URL}       │`);
  console.log(`  │   Model:  ${settings.model.padEnd(27)}│`);
  console.log('  │                                          │');
  console.log('  └──────────────────────────────────────────┘');
  console.log('');
});
