const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');
const { exec } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

// ── yt-dlp extract info ─────────────────────────────
function ytdlp(url, extraArgs = '') {
  return new Promise((resolve, reject) => {
    const fs = require('fs');
    const cookiesArg = fs.existsSync('/var/www/api/cookies.txt') ? '--cookies /var/www/api/cookies.txt' : '';
    const cmd = `yt-dlp --no-warnings --dump-json ${cookiesArg} ${extraArgs} "${url}"`;
    exec(cmd, { timeout: 45000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      try { resolve(JSON.parse(stdout)); }
      catch(e) { reject(new Error('JSON parse failed')); }
    });
  });
}

// ── Platform detection ──────────────────────────────
function detectPlatform(u) {
  u = (u||'').toLowerCase();
  if (u.includes('tiktok')||u.includes('douyin')) return 'tiktok';
  if (u.includes('youtube')||u.includes('youtu.be')) return 'youtube';
  if (u.includes('instagram')) return 'instagram';
  if (u.includes('facebook')||u.includes('fb.watch')) return 'facebook';
  if (u.includes('twitter')||u.includes('x.com')) return 'twitter';
  if (u.includes('reddit')||u.includes('redd.it')) return 'reddit';
  if (u.includes('pinterest')) return 'pinterest';
  if (u.includes('vimeo')) return 'vimeo';
  return 'other';
}

// ── TikWM for TikTok (yt-dlp has issues with TikTok) ─
function tikwm(url) {
  return new Promise((resolve, reject) => {
    const key = '582b4869135cf0cd6ac56c64453e42d4';
    const body = `url=${encodeURIComponent(url)}&hd=1&web=1&token=${key}`;
    const req = https.request({
      hostname: 'tikwm.com', path: '/api/', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

// ── PROXY endpoint ──────────────────────────────────
app.get('/proxy', (req, res) => {
  const { url: rawUrl, filename = 'vidsavepro', ext = 'mp4' } = req.query;
  if (!rawUrl) return res.status(400).send('No URL');

  const videoUrl = decodeURIComponent(rawUrl);
  const safeFile = (filename||'vidsavepro').replace(/[^\w\s\-\.]/g,'_').substring(0,80);
  const safeExt  = (ext||'mp4').replace(/[^a-z0-9]/g,'') || 'mp4';
  const mimes    = { mp4:'video/mp4', webm:'video/webm', mp3:'audio/mpeg', m4a:'audio/mp4', jpg:'image/jpeg' };
  const mime     = mimes[safeExt] || 'video/mp4';

  let referer = 'https://www.google.com/';
  if (videoUrl.includes('googlevideo'))   referer = 'https://www.youtube.com/';
  else if (videoUrl.includes('fbcdn') || videoUrl.includes('cdninstagram')) referer = 'https://www.instagram.com/';
  else if (videoUrl.includes('twimg'))    referer = 'https://twitter.com/';
  else if (videoUrl.includes('tiktok'))   referer = 'https://www.tiktok.com/';

  try {
    const parsed = new URL(videoUrl);
    const mod = parsed.protocol === 'https:' ? https : http;
    const proxyReq = mod.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      timeout: 120000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0',
        'Accept': '*/*', 'Accept-Encoding': 'identity',
        'Referer': referer, 'Origin': referer.replace(/\/$/, '')
      }
    }, proxyRes => {
      if (proxyRes.statusCode >= 400) return res.status(502).json({ error: `Source: ${proxyRes.statusCode}` });
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Disposition', `attachment; filename="${safeFile}.${safeExt}"`);
      if (proxyRes.headers['content-length']) res.setHeader('Content-Length', proxyRes.headers['content-length']);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Access-Control-Allow-Origin', '*');
      proxyRes.pipe(res);
    });
    proxyReq.on('error', err => { if (!res.headersSent) res.status(502).json({ error: err.message }); });
    proxyReq.on('timeout', () => { proxyReq.destroy(); if (!res.headersSent) res.status(504).json({ error: 'timeout' }); });
    proxyReq.end();
  } catch(e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// ── DOWNLOAD endpoint ───────────────────────────────
app.post('/download', async (req, res) => {
  const { url: videoUrl } = req.body;
  if (!videoUrl) return res.json({ success: false, error: 'No URL' });

  const platform = detectPlatform(videoUrl);

  // ── TIKTOK via TikWM ─────────────────────────────
  if (platform === 'tiktok') {
    try {
      const d = await tikwm(videoUrl);
      if (d?.code === 0 && d?.data) {
        const v = d.data, vid = v.id || '';
        const medias = [];
        if (vid) {
          medias.push({ url: `https://tikwm.com/video/media/hdplay/${vid}.mp4`, quality: '⭐ 4K HD — No Watermark', ext: 'mp4', direct: true });
          medias.push({ url: `https://tikwm.com/video/media/play/${vid}.mp4`,   quality: '🎬 HD — No Watermark',   ext: 'mp4', direct: true });
          medias.push({ url: `https://tikwm.com/video/music/${vid}.mp3`,        quality: '🎵 Audio MP3',            ext: 'mp3', direct: true });
        }
        if (v.images) v.images.forEach((img, i) => medias.push({ url: img, quality: `🖼 Image ${i+1}`, ext: 'jpg', direct: true }));
        return res.json({
          success: true, platform: 'tiktok',
          title: v.title || (v.author?.nickname || 'TikTok') + ' Video',
          thumb: v.origin_cover || v.cover || '',
          author: v.author?.nickname || '',
          duration: v.duration || 0,
          medias
        });
      }
    } catch(e) {}
    return res.json({ success: false, error: 'TikTok failed' });
  }

  // ── ALL OTHER PLATFORMS via yt-dlp ───────────────
  try {
    const info = await ytdlp(videoUrl);
    const title = info.title || 'Video';
    const thumb = info.thumbnail || '';

    // YouTube: get merged formats only
    if (platform === 'youtube') {
      const formats = (info.formats || []);
      
      // Find combined formats (has both video and audio)
      const combined = formats.filter(f =>
        f.vcodec !== 'none' && f.acodec !== 'none' &&
        f.ext === 'mp4' && f.height > 0
      ).sort((a, b) => (b.height || 0) - (a.height || 0));

      // Remove duplicates by height
      const seen = {};
      const unique = combined.filter(f => {
        if (seen[f.height]) return false;
        seen[f.height] = true;
        return true;
      });

      // Best audio
      const audioFmt = formats.filter(f => f.vcodec === 'none' && f.acodec !== 'none')
        .sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];

      const medias = unique.map(f => ({
        url: f.url, ext: 'mp4', stream: true,
        quality: f.height >= 2160 ? '⭐ 4K (2160p)' :
                 f.height >= 1440 ? '⭐ 2K (1440p)' :
                 f.height >= 1080 ? '🎬 Full HD (1080p)' :
                 f.height >= 720  ? '📹 HD (720p)' :
                 f.height >= 480  ? '📹 SD (480p)' : `📹 ${f.height}p`
      }));

      if (audioFmt) medias.push({ url: audioFmt.url, quality: '🎵 Audio Only', ext: audioFmt.ext || 'm4a', stream: true });

      return res.json({ success: true, platform: 'youtube', title, thumb, medias });
    }

    // Instagram, Facebook, Twitter, Reddit, Vimeo etc
    const formats = (info.formats || []);
    
    // Get best video formats
    const videoFmts = formats.filter(f =>
      f.vcodec !== 'none' && f.url && f.height > 0
    ).sort((a, b) => (b.height || 0) - (a.height || 0));

    // Remove duplicate heights
    const seen = {};
    const unique = videoFmts.filter(f => {
      if (seen[f.height]) return false;
      seen[f.height] = true;
      return true;
    }).slice(0, 4);

    // If no formats found, use url directly
    if (!unique.length && info.url) {
      return res.json({
        success: true, platform, title, thumb,
        medias: [{ url: info.url, quality: '🎬 HD Video', ext: info.ext || 'mp4', stream: true }]
      });
    }

    const medias = unique.map(f => ({
      url: f.url, stream: true,
      ext: f.ext || 'mp4',
      quality: f.height >= 1080 ? '🎬 Full HD (1080p)' :
               f.height >= 720  ? '📹 HD (720p)' :
               f.height >= 480  ? '📹 SD (480p)' : `📹 ${f.height}p`
    }));

    // Add audio if available
    const audioFmt = formats.filter(f => f.vcodec === 'none' && f.acodec !== 'none' && f.url)
      .sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];
    if (audioFmt) medias.push({ url: audioFmt.url, quality: '🎵 Audio Only', ext: audioFmt.ext || 'm4a', stream: true });

    return res.json({ success: true, platform, title, thumb, medias });

  } catch(e) {
    return res.json({ success: false, error: `Could not fetch video: ${e.message}` });
  }
});

app.get('/', (req, res) => res.json({ status: 'VidSave Pro API v6 - yt-dlp powered', ok: true }));
app.get('/health', (req, res) => res.json({ ok: true }));
app.listen(PORT, () => console.log(`VidSave Pro API v6 on port ${PORT}`));
