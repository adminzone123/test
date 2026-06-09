const express = require('express');
const cors    = require('cors');
const https   = require('https');
const http    = require('http');
const url     = require('url');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ── Detect Platform ─────────────────────────────────────
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

// ── Fetch helper ────────────────────────────────────────
function fetchJson(reqUrl, options={}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(reqUrl);
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', ...(options.headers||{}) }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve(null); }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function postJson(reqUrl, body, headers={}) {
  const bodyStr = JSON.stringify(body);
  return fetchJson(reqUrl, {
    method: 'POST',
    body: bodyStr,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr), ...headers }
  });
}

// ── RapidAPI helper ─────────────────────────────────────
async function callRapidApi(videoUrl) {
  const key  = process.env.RAPIDAPI_KEY || '70100c663emsh52898dfd9e8465ep1f4f1cjsn48887eaf4470';
  const host = 'social-download-all-in-one.p.rapidapi.com';
  return postJson(`https://${host}/v1/social/autolink`, { url: videoUrl }, {
    'x-rapidapi-key': key,
    'x-rapidapi-host': host
  });
}

// ── TikWM helper ────────────────────────────────────────
async function callTikWM(videoUrl) {
  const key = process.env.TIKWM_KEY || '582b4869135cf0cd6ac56c64453e42d4';
  const body = `url=${encodeURIComponent(videoUrl)}&hd=1&web=1&token=${key}`;
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'tikwm.com', path: '/api/', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let d=''; res.on('data',c=>d+=c);
      res.on('end',()=>{ try{resolve(JSON.parse(d));}catch{resolve(null);} });
    });
    req.on('error',()=>resolve(null));
    req.write(body); req.end();
  });
}

// ── Build quality label ─────────────────────────────────
function buildLabel(item) {
  const ext   = (item.extension||item.ext||'mp4').toLowerCase();
  const type  = item.type||'video';
  const q     = (item.quality||item.label||'').trim();
  const h     = parseInt(item.height||0);
  const w     = parseInt(item.width||0);
  const isAud = type==='audio'||['mp3','m4a','opus'].includes(ext);

  if (isAud) {
    const kb = (q.match(/(\d+)\s*kb/i)||[])[1]||'';
    return { icon:'🎵', label:`Audio MP3${kb?` (${kb}kbps)`:''}`, ext: ['m4a','mp3'].includes(ext)?ext:'mp3' };
  }
  if (q.toUpperCase()==='HD') return { icon:'🎬', label:'HD Quality', ext };
  if (q.toUpperCase()==='SD') return { icon:'📹', label:'SD Quality', ext };

  const dim = Math.max(w,h) || parseInt((q.match(/(\d{3,4})/)||[])[1]||0);
  if (dim>=2160) return { icon:'⭐', label:'4K Ultra HD (2160p)', ext };
  if (dim>=1440) return { icon:'⭐', label:'2K QHD (1440p)', ext };
  if (dim>=1080) return { icon:'🎬', label:'Full HD (1080p)', ext };
  if (dim>=720)  return { icon:'📹', label:'HD (720p)', ext };
  if (dim>=480)  return { icon:'📹', label:'SD (480p)', ext };
  if (dim>=360)  return { icon:'📹', label:'360p', ext };
  if (q)         return { icon:'🎬', label:q, ext };
  return { icon:'🎬', label:'HD Video', ext };
}

// ── Proxy stream endpoint ────────────────────────────────
// This runs on Render server — same IP as API call — so URLs work!
app.get('/proxy', async (req, res) => {
  const { url: videoUrl, filename='vidsavepro', ext='mp4' } = req.query;
  if (!videoUrl) return res.status(400).json({ error: 'No URL' });

  const referers = {
    'googlevideo': 'https://www.youtube.com/',
    'fbcdn':       'https://www.instagram.com/',
    'cdninstagram':'https://www.instagram.com/',
    'twimg':       'https://twitter.com/',
    'tikwm':       'https://www.tiktok.com/',
  };
  let referer = 'https://www.google.com/';
  for (const [key, val] of Object.entries(referers)) {
    if (videoUrl.includes(key)) { referer = val; break; }
  }

  const mimes = { mp4:'video/mp4', webm:'video/webm', mp3:'audio/mpeg',
                  m4a:'audio/mp4', jpg:'image/jpeg', png:'image/png' };
  const mime = mimes[ext]||'video/mp4';
  const safeFile = filename.replace(/[^\w\s\-]/g,'_').substring(0,80);

  const parsed = new URL(decodeURIComponent(videoUrl));
  const mod = parsed.protocol==='https:'?https:http;

  const proxyReq = mod.request({
    hostname: parsed.hostname,
    path: parsed.pathname + parsed.search,
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0',
      'Referer': referer,
      'Origin': referer.replace(/\/$/,''),
      'Accept': '*/*',
      'Accept-Encoding': 'identity',
    }
  }, proxyRes => {
    const status = proxyRes.statusCode;
    if (status >= 400) return res.status(502).json({ error: `Source returned ${status}` });

    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename="${safeFile}.${ext}"`);
    if (proxyRes.headers['content-length'])
      res.setHeader('Content-Length', proxyRes.headers['content-length']);
    res.setHeader('Cache-Control', 'no-store');
    proxyRes.pipe(res);
  });

  proxyReq.on('error', err => {
    if (!res.headersSent) res.status(502).json({ error: err.message });
  });
  proxyReq.end();
});

// ── Main download endpoint ───────────────────────────────
app.post('/download', async (req, res) => {
  const { url: videoUrl } = req.body;
  if (!videoUrl) return res.json({ success:false, error:'No URL' });

  const platform = detectPlatform(videoUrl);

  // TikTok
  if (platform==='tiktok') {
    const d = await callTikWM(videoUrl);
    if (d?.code===0 && d?.data) {
      const v=d.data, vid=v.id||'';
      const medias=[];
      if (vid) {
        medias.push({url:`https://tikwm.com/video/media/hdplay/${vid}.mp4`,quality:'⭐ 4K HD — No Watermark',ext:'mp4',direct:true});
        medias.push({url:`https://tikwm.com/video/media/play/${vid}.mp4`,  quality:'🎬 HD — No Watermark',   ext:'mp4',direct:true});
        medias.push({url:`https://tikwm.com/video/music/${vid}.mp3`,       quality:'🎵 Audio MP3',            ext:'mp3',direct:true});
      }
      if (v.images) v.images.forEach((img,i)=>medias.push({url:img,quality:`🖼 Image ${i+1}`,ext:'jpg',direct:true}));
      return res.json({ success:true, platform:'tiktok',
        title: v.title||(v.author?.nickname||'TikTok')+' Video',
        thumb: v.origin_cover||v.cover||'',
        author:v.author?.nickname||'', duration:v.duration||0,
        plays:v.play_count||0, likes:v.digg_count||0, medias });
    }
  }

  // All others via RapidAPI
  const d = await callRapidApi(videoUrl);
  if (!d?.medias?.length) return res.json({ success:false, error:'Could not fetch video. Please try again.' });

  let title = d.title||'';
  const thumb = d.thumbnail||'';

  if (platform==='facebook' && (!title||title==='-'||title.startsWith('- '))) title='Facebook Video';

  // YouTube: only mp4, deduplicate heights, all qualities
  if (platform==='youtube') {
    const videos=[], seenH={};
    let audioItem=null;
    for (const item of d.medias) {
      if (!item.url) continue;
      const ext=(item.extension||item.ext||'').toLowerCase();
      const h=parseInt(item.height||0);
      if (item.type==='audio'&&ext==='m4a'&&!audioItem) { audioItem=item; continue; }
      if (item.type==='video'&&ext==='mp4'&&h>0&&!seenH[h]) { seenH[h]=true; videos.push(item); }
    }
    videos.sort((a,b)=>(parseInt(b.height||0)-parseInt(a.height||0)));
    if (audioItem) videos.push(audioItem);
    const medias = videos.map(item => {
      const bl=buildLabel(item);
      return { url:item.url, quality:`${bl.icon} ${bl.label}`, ext:bl.ext, stream:true };
    });
    if (!title) title='YouTube Video';
    return res.json({ success:true, platform:'youtube', title, thumb, medias });
  }

  // Instagram/Facebook/Others
  const medias=[], seenLabels={};
  for (const item of d.medias) {
    if (!item.url) continue;
    const ext=(item.extension||item.ext||'mp4').toLowerCase();
    if (['opus','webm'].includes(ext)) continue;
    const bl=buildLabel(item);
    if (seenLabels[bl.label]) continue;
    seenLabels[bl.label]=true;
    medias.push({ url:item.url, quality:`${bl.icon} ${bl.label}`, ext:bl.ext, stream:true });
  }
  medias.sort((a,b)=>{
    const aA=a.quality.includes('🎵'), bA=b.quality.includes('🎵');
    return aA&&!bA?1:(!aA&&bA?-1:0);
  });

  res.json({ success:true, platform, title, thumb, medias });
});

app.get('/', (req,res) => res.json({ status:'VidSave Pro API running', version:'2.0' }));
app.listen(PORT, () => console.log(`VidSave Pro API running on port ${PORT}`));
