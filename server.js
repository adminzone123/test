const express = require('express');
const cors    = require('cors');
const https   = require('https');
const http    = require('http');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ── Platform detection ───────────────────────────────────
function detectPlatform(u) {
  u = (u||'').toLowerCase();
  if (u.includes('tiktok')||u.includes('douyin')) return 'tiktok';
  if (u.includes('youtube')||u.includes('youtu.be')) return 'youtube';
  if (u.includes('instagram')) return 'instagram';
  if (u.includes('facebook')||u.includes('fb.watch')) return 'facebook';
  if (u.includes('twitter')||u.includes('x.com')) return 'twitter';
  if (u.includes('reddit')||u.includes('redd.it')) return 'reddit';
  return 'other';
}

// ── HTTP fetch helper ────────────────────────────────────
function fetchUrl(reqUrl, options={}) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(reqUrl);
    const mod     = parsed.protocol === 'https:' ? https : http;
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0',
      'Accept': '*/*',
      ...(options.headers||{})
    };
    const req = mod.request({
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol==='https:'?443:80),
      path:     parsed.pathname + parsed.search,
      method:   options.method || 'GET',
      headers,
      timeout:  30000,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

function postJson(url, body, headers={}) {
  const b = JSON.stringify(body);
  return fetchUrl(url, {
    method: 'POST', body: b,
    headers: { 'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(b), ...headers }
  });
}

// ── RapidAPI ─────────────────────────────────────────────
async function callRapidApi(videoUrl) {
  const key  = process.env.RAPIDAPI_KEY || '70100c663emsh52898dfd9e8465ep1f4f1cjsn48887eaf4470';
  const host = 'social-download-all-in-one.p.rapidapi.com';
  const r = await postJson(`https://${host}/v1/social/autolink`, { url: videoUrl }, {
    'x-rapidapi-key':  key,
    'x-rapidapi-host': host
  });
  return JSON.parse(r.body.toString());
}

// ── TikWM ────────────────────────────────────────────────
async function callTikWM(videoUrl) {
  const key  = process.env.TIKWM_KEY || '582b4869135cf0cd6ac56c64453e42d4';
  const body = `url=${encodeURIComponent(videoUrl)}&hd=1&web=1&token=${key}`;
  const r    = await fetchUrl('https://tikwm.com/api/', {
    method: 'POST', body,
    headers: { 'Content-Type':'application/x-www-form-urlencoded', 'Content-Length':Buffer.byteLength(body) }
  });
  return JSON.parse(r.body.toString());
}

// ── Build quality label ──────────────────────────────────
function buildLabel(item) {
  const ext   = (item.extension||item.ext||'mp4').toLowerCase();
  const type  = item.type||'video';
  const q     = (item.quality||item.label||'').trim();
  const h     = parseInt(item.height||0);
  const w     = parseInt(item.width||0);
  const isAud = type==='audio'||['mp3','m4a','opus'].includes(ext);

  if (isAud) {
    const kb = (q.match(/(\d+)\s*kb/i)||[])[1]||'';
    return { icon:'🎵', label:`Audio MP3${kb?` (${kb}kbps)`:''}`, ext:['m4a','mp3'].includes(ext)?ext:'mp3' };
  }
  if (q.toUpperCase()==='HD') return { icon:'🎬', label:'HD Quality', ext };
  if (q.toUpperCase()==='SD') return { icon:'📹', label:'SD Quality', ext };

  const dim = Math.max(w,h) || parseInt((q.match(/(\d{3,4})/)||[])[1]||0);
  if (dim>=2160) return { icon:'⭐', label:'4K Ultra HD (2160p)', ext };
  if (dim>=1440) return { icon:'⭐', label:'2K QHD (1440p)',      ext };
  if (dim>=1080) return { icon:'🎬', label:'Full HD (1080p)',     ext };
  if (dim>=720)  return { icon:'📹', label:'HD (720p)',           ext };
  if (dim>=480)  return { icon:'📹', label:'SD (480p)',           ext };
  if (dim>=360)  return { icon:'📹', label:'360p',                ext };
  if (q)         return { icon:'🎬', label:q,                     ext };
  return { icon:'🎬', label:'HD Video', ext };
}

// ── /proxy — stream video to browser ────────────────────
// This is the KEY endpoint — Render server fetches video
// using same IP that got the signed URL from RapidAPI
app.get('/proxy', (req, res) => {
  const { url: rawUrl, filename='vidsavepro', ext='mp4' } = req.query;
  if (!rawUrl) return res.status(400).send('No URL');

  const videoUrl  = decodeURIComponent(rawUrl);
  const safeFile  = filename.replace(/[^\w\s\-\.]/g,'_').substring(0,80)||'vidsavepro';
  const safeExt   = ext.replace(/[^a-z0-9]/g,'')||'mp4';
  const mimes     = { mp4:'video/mp4', webm:'video/webm', mp3:'audio/mpeg', m4a:'audio/mp4', jpg:'image/jpeg', png:'image/png' };
  const mime      = mimes[safeExt]||'video/mp4';

  // Best referer per CDN
  let referer = 'https://www.google.com/';
  if (videoUrl.includes('googlevideo'))   referer = 'https://www.youtube.com/';
  else if (videoUrl.includes('fbcdn')||videoUrl.includes('cdninstagram')) referer = 'https://www.instagram.com/';
  else if (videoUrl.includes('twimg'))    referer = 'https://twitter.com/';
  else if (videoUrl.includes('tikwm'))    referer = 'https://www.tiktok.com/';

  const parsed = new URL(videoUrl);
  const mod    = parsed.protocol==='https:' ? https : http;

  const proxyReq = mod.request({
    hostname: parsed.hostname,
    port:     parsed.port || (parsed.protocol==='https:'?443:80),
    path:     parsed.pathname + parsed.search,
    method:   'GET',
    timeout:  120000,
    headers: {
      'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0',
      'Accept':          '*/*',
      'Accept-Encoding': 'identity',
      'Referer':          referer,
      'Origin':           referer.replace(/\/$/,''),
    }
  }, proxyRes => {
    if (proxyRes.statusCode >= 400) {
      return res.status(502).json({ error: `Source returned ${proxyRes.statusCode}` });
    }
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename="${safeFile}.${safeExt}"`);
    if (proxyRes.headers['content-length'])
      res.setHeader('Content-Length', proxyRes.headers['content-length']);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');
    // Stream directly — no buffering
    proxyRes.pipe(res);
  });

  proxyReq.on('error', err => {
    if (!res.headersSent) res.status(502).json({ error: err.message });
  });
  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    if (!res.headersSent) res.status(504).json({ error: 'Proxy timeout' });
  });
  proxyReq.end();
});

// ── /download — get video info + media URLs ──────────────
app.post('/download', async (req, res) => {
  const { url: videoUrl } = req.body;
  if (!videoUrl) return res.json({ success:false, error:'No URL' });

  const platform = detectPlatform(videoUrl);

  // TikTok
  if (platform==='tiktok') {
    try {
      const d = await callTikWM(videoUrl);
      if (d?.code===0 && d?.data) {
        const v=d.data, vid=v.id||'';
        const medias=[];
        if (vid) {
          medias.push({url:`https://tikwm.com/video/media/hdplay/${vid}.mp4`,quality:'⭐ 4K HD — No Watermark',ext:'mp4',direct:true});
          medias.push({url:`https://tikwm.com/video/media/play/${vid}.mp4`,  quality:'🎬 HD — No Watermark',   ext:'mp4',direct:true});
          medias.push({url:`https://tikwm.com/video/music/${vid}.mp3`,       quality:'🎵 Audio MP3',            ext:'mp3',direct:true});
        }
        if (v.images) v.images.forEach((img,i) => medias.push({url:img, quality:`🖼 Image ${i+1}`, ext:'jpg', direct:true}));
        return res.json({ success:true, platform:'tiktok',
          title:  v.title||(v.author?.nickname||'TikTok')+' Video',
          thumb:  v.origin_cover||v.cover||'',
          author: v.author?.nickname||'',
          duration: v.duration||0, plays: v.play_count||0, likes: v.digg_count||0,
          medias });
      }
    } catch(e) {}
  }

  // All others via RapidAPI
  try {
    const d = await callRapidApi(videoUrl);
    if (!d?.medias?.length) return res.json({ success:false, error:'Could not fetch video' });

    let title = d.title||'';
    const thumb = d.thumbnail||'';
    if (platform==='facebook' && (!title||title.startsWith('-'))) title='Facebook Video';

    // YouTube: only combined video+audio formats (360p, 720p)
    // 1080p+ are video-only streams that need ffmpeg merge — not supported on free Render
    if (platform==='youtube') {
      const combined=[], audioOnly=[];
      for (const item of d.medias) {
        if (!item.url) continue;
        const ext = (item.extension||item.ext||'').toLowerCase();
        const fid = parseInt(item.formatId||0);
        const h   = parseInt(item.height||0);
        // Audio only
        if (item.type==='audio' && ext==='m4a') { audioOnly.push(item); continue; }
        // Combined streams: formatId 18=360p, 22=720p, or has audioQuality (not null)
        if (ext==='mp4' && item.type==='video') {
          const hasAudio = item.audioQuality && item.audioQuality !== null && item.audioQuality !== 'none';
          const isCombined = fid===18 || fid===22 || hasAudio;
          if (isCombined && h>0) combined.push(item);
        }
      }
      // Sort best quality first
      combined.sort((a,b) => parseInt(b.height||0)-parseInt(a.height||0));
      // Fallback: use lowest height mp4s (usually combined)
      if (!combined.length) {
        const allmp4 = d.medias
          .filter(i=>i.url&&(i.extension||i.ext||'').toLowerCase()==='mp4'&&i.type==='video'&&parseInt(i.height||0)>0)
          .sort((a,b)=>parseInt(a.height||0)-parseInt(b.height||0));
        combined.push(...allmp4.slice(0,2));
      }
      const medias = combined.map(item => {
        const bl=buildLabel(item);
        return { url:item.url, quality:`${bl.icon} ${bl.label}`, ext:bl.ext, stream:true };
      });
      // Add best audio
      if (audioOnly.length) {
        const best=audioOnly[audioOnly.length-1];
        const bl=buildLabel(best);
        medias.push({ url:best.url, quality:`${bl.icon} ${bl.label}`, ext:bl.ext, stream:true });
      }
      return res.json({ success:true, platform:'youtube', title:title||'YouTube Video', thumb, medias });
    }

    // Others: clean labels, deduplicate
    const medias=[], seenL={};
    for (const item of d.medias) {
      if (!item.url) continue;
      const ext=(item.extension||item.ext||'mp4').toLowerCase();
      if (['opus','webm'].includes(ext)) continue;
      const bl=buildLabel(item);
      if (seenL[bl.label]) continue;
      seenL[bl.label]=true;
      medias.push({ url:item.url, quality:`${bl.icon} ${bl.label}`, ext:bl.ext, stream:true });
    }
    medias.sort((a,b)=>{
      const aA=a.quality.includes('🎵'), bA=b.quality.includes('🎵');
      return aA&&!bA?1:!aA&&bA?-1:0;
    });
    return res.json({ success:true, platform, title, thumb, medias });

  } catch(e) {
    return res.json({ success:false, error:'Server error: '+e.message });
  }
});

app.get('/', (req,res) => res.json({ status:'VidSave Pro API', version:'3.0', platforms:['tiktok','youtube','instagram','facebook','twitter','reddit'] }));
app.get('/health', (req,res) => res.json({ ok:true }));

app.listen(PORT, () => console.log(`VidSave Pro API v3 running on port ${PORT}`));
