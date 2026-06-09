const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

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

function makeRequest(url, options={}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port||(parsed.protocol==='https:'?443:80),
      path: parsed.pathname+parsed.search,
      method: options.method||'GET',
      headers: {'User-Agent':'Mozilla/5.0','Accept':'*/*',...(options.headers||{})},
      timeout: 30000
    }, res => {
      const chunks=[];
      res.on('data',c=>chunks.push(c));
      res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));
    });
    req.on('error',reject);
    req.on('timeout',()=>{req.destroy();reject(new Error('timeout'));});
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function callRapidApi(videoUrl) {
  const key = process.env.RAPIDAPI_KEY||'70100c663emsh52898dfd9e8465ep1f4f1cjsn48887eaf4470';
  const host = 'social-download-all-in-one.p.rapidapi.com';
  const body = JSON.stringify({url:videoUrl});
  const r = await makeRequest(`https://${host}/v1/social/autolink`,{
    method:'POST', body,
    headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body),
             'x-rapidapi-key':key,'x-rapidapi-host':host}
  });
  return JSON.parse(r.body.toString());
}

async function callTikWM(videoUrl) {
  const key = process.env.TIKWM_KEY||'582b4869135cf0cd6ac56c64453e42d4';
  const body = `url=${encodeURIComponent(videoUrl)}&hd=1&web=1&token=${key}`;
  const r = await makeRequest('https://tikwm.com/api/',{
    method:'POST', body,
    headers:{'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(body)}
  });
  return JSON.parse(r.body.toString());
}

// Build nice label
function buildLabel(item) {
  const ext = (item.extension||item.ext||'mp4').toLowerCase();
  const type = item.type||'video';
  const q = (item.quality||item.label||'').trim();
  const h = parseInt(item.height||0);
  const w = parseInt(item.width||0);
  const isAud = type==='audio'||['mp3','m4a','opus'].includes(ext);
  if (isAud) {
    const kb=(q.match(/(\d+)\s*kb/i)||[])[1]||'';
    return {icon:'🎵',label:`Audio MP3${kb?` (${kb}kbps)`:''}`,ext:['m4a','mp3'].includes(ext)?ext:'mp3'};
  }
  if (q.toUpperCase()==='HD') return {icon:'🎬',label:'HD Quality',ext};
  if (q.toUpperCase()==='SD') return {icon:'📹',label:'SD Quality',ext};
  const dim=Math.max(w,h)||parseInt((q.match(/(\d{3,4})/)||[])[1]||0);
  if (dim>=2160) return {icon:'⭐',label:'4K (2160p)',ext};
  if (dim>=1440) return {icon:'⭐',label:'2K (1440p)',ext};
  if (dim>=1080) return {icon:'🎬',label:'Full HD (1080p)',ext};
  if (dim>=720)  return {icon:'📹',label:'HD (720p)',ext};
  if (dim>=480)  return {icon:'📹',label:'SD (480p)',ext};
  if (dim>=360)  return {icon:'📹',label:'360p',ext};
  if (q) return {icon:'🎬',label:q,ext};
  return {icon:'🎬',label:'HD Video',ext};
}

// PROXY — stream video directly from Render server
app.get('/proxy', (req, res) => {
  const {url:rawUrl, filename='vidsavepro', ext='mp4'} = req.query;
  if (!rawUrl) return res.status(400).send('No URL');
  
  const videoUrl = decodeURIComponent(rawUrl);
  const safeFile = (filename||'vidsavepro').replace(/[^\w\s\-\.]/g,'_').substring(0,80);
  const safeExt  = (ext||'mp4').replace(/[^a-z0-9]/g,'')||'mp4';
  const mimes    = {mp4:'video/mp4',webm:'video/webm',mp3:'audio/mpeg',m4a:'audio/mp4',jpg:'image/jpeg',png:'image/png'};
  const mime     = mimes[safeExt]||'video/mp4';

  let referer = 'https://www.google.com/';
  if (videoUrl.includes('googlevideo')) referer='https://www.youtube.com/';
  else if (videoUrl.includes('fbcdn')||videoUrl.includes('cdninstagram')) referer='https://www.instagram.com/';
  else if (videoUrl.includes('twimg')) referer='https://twitter.com/';
  else if (videoUrl.includes('tikwm')) referer='https://www.tiktok.com/';

  try {
    const parsed = new URL(videoUrl);
    const mod = parsed.protocol==='https:'?https:http;
    const proxyReq = mod.request({
      hostname:parsed.hostname,
      port:parsed.port||(parsed.protocol==='https:'?443:80),
      path:parsed.pathname+parsed.search,
      method:'GET',
      timeout:120000,
      headers:{
        'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0',
        'Accept':'*/*','Accept-Encoding':'identity',
        'Referer':referer,'Origin':referer.replace(/\/$/,'')
      }
    }, proxyRes => {
      if (proxyRes.statusCode>=400) return res.status(502).json({error:`Source: ${proxyRes.statusCode}`});
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Disposition', `attachment; filename="${safeFile}.${safeExt}"`);
      if (proxyRes.headers['content-length']) res.setHeader('Content-Length', proxyRes.headers['content-length']);
      res.setHeader('Cache-Control','no-store');
      res.setHeader('Access-Control-Allow-Origin','*');
      proxyRes.pipe(res);
    });
    proxyReq.on('error', err=>{if(!res.headersSent) res.status(502).json({error:err.message});});
    proxyReq.on('timeout',()=>{proxyReq.destroy();if(!res.headersSent) res.status(504).json({error:'timeout'});});
    proxyReq.end();
  } catch(e) {
    if(!res.headersSent) res.status(500).json({error:e.message});
  }
});

// DEBUG endpoint — see raw API response for YouTube
app.get('/debug', async (req, res) => {
  const {url} = req.query;
  if (!url) return res.json({error:'add ?url=YOUTUBE_LINK'});
  try {
    const d = await callRapidApi(decodeURIComponent(url));
    const summary = (d.medias||[]).map(m=>({
      formatId: m.formatId,
      quality:  m.quality,
      label:    m.label,
      type:     m.type,
      ext:      m.extension||m.ext,
      height:   m.height,
      width:    m.width,
      audioQ:   m.audioQuality,
      is_audio: m.is_audio,
      has_url:  !!m.url
    }));
    res.json({title:d.title, total:summary.length, formats:summary});
  } catch(e) {
    res.json({error:e.message});
  }
});

// DOWNLOAD endpoint
app.post('/download', async (req, res) => {
  const {url:videoUrl} = req.body;
  if (!videoUrl) return res.json({success:false,error:'No URL'});
  const platform = detectPlatform(videoUrl);

  // TikTok
  if (platform==='tiktok') {
    try {
      const d = await callTikWM(videoUrl);
      if (d?.code===0&&d?.data) {
        const v=d.data, vid=v.id||'';
        const medias=[];
        if (vid) {
          medias.push({url:`https://tikwm.com/video/media/hdplay/${vid}.mp4`,quality:'⭐ 4K HD — No Watermark',ext:'mp4',direct:true});
          medias.push({url:`https://tikwm.com/video/media/play/${vid}.mp4`,quality:'🎬 HD — No Watermark',ext:'mp4',direct:true});
          medias.push({url:`https://tikwm.com/video/music/${vid}.mp3`,quality:'🎵 Audio MP3',ext:'mp3',direct:true});
        }
        if (v.images) v.images.forEach((img,i)=>medias.push({url:img,quality:`🖼 Image ${i+1}`,ext:'jpg',direct:true}));
        return res.json({success:true,platform:'tiktok',
          title:v.title||(v.author?.nickname||'TikTok')+' Video',
          thumb:v.origin_cover||v.cover||'',
          author:v.author?.nickname||'',duration:v.duration||0,
          plays:v.play_count||0,likes:v.digg_count||0,medias});
      }
    } catch(e){}
  }

  // All others
  try {
    const d = await callRapidApi(videoUrl);
    if (!d?.medias?.length) return res.json({success:false,error:'Could not fetch video'});

    let title=d.title||'', thumb=d.thumbnail||'';
    if (platform==='facebook'&&(!title||title.startsWith('-'))) title='Facebook Video';

    // YOUTUBE — pick only formats where is_audio=true (combined) OR formatId 18/22
    if (platform==='youtube') {
      const good=[], audioOnly=[];
      for (const item of d.medias) {
        if (!item.url) continue;
        const ext=(item.extension||item.ext||'').toLowerCase();
        const fid=parseInt(item.formatId||0);
        const h=parseInt(item.height||0);

        // Pure audio track
        if (item.type==='audio'&&(ext==='m4a'||ext==='mp3')) {
          audioOnly.push(item); continue;
        }

        // is_audio=true on a video item means it has BOTH video+audio
        if (ext==='mp4'&&item.type==='video'&&h>0) {
          // formatId 18 = 360p combined, 22 = 720p combined
          if (fid===18||fid===22) { good.push(item); continue; }
          // Some APIs set is_audio=true for combined streams
          if (item.is_audio===true) { good.push(item); continue; }
          // audioQuality present and not null = combined
          if (item.audioQuality && item.audioQuality!=='none' && item.audioQuality!==null) {
            good.push(item); continue;
          }
        }
      }

      // Sort by height desc
      good.sort((a,b)=>parseInt(b.height||0)-parseInt(a.height||0));

      // If still nothing, fallback: pick lowest 2 mp4 heights (usually combined)
      if (!good.length) {
        const allmp4=d.medias.filter(i=>i.url&&(i.extension||i.ext||'').toLowerCase()==='mp4'&&i.type==='video'&&parseInt(i.height||0)>0);
        allmp4.sort((a,b)=>parseInt(a.height||0)-parseInt(b.height||0));
        good.push(...allmp4.slice(0,2));
      }

      const medias=good.map(item=>{
        const bl=buildLabel(item);
        return {url:item.url,quality:`${bl.icon} ${bl.label}`,ext:bl.ext,stream:true};
      });
      if (audioOnly.length) {
        const best=audioOnly[audioOnly.length-1];
        const bl=buildLabel(best);
        medias.push({url:best.url,quality:`${bl.icon} ${bl.label}`,ext:bl.ext,stream:true});
      }
      if (!title) title='YouTube Video';
      if (!thumb) {
        const vm=videoUrl.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
        if (vm) thumb=`https://img.youtube.com/vi/${vm[1]}/hqdefault.jpg`;
      }
      return res.json({success:true,platform:'youtube',title,thumb,medias});
    }

    // Others
    const medias=[], seenL={};
    for (const item of d.medias) {
      if (!item.url) continue;
      const ext=(item.extension||item.ext||'mp4').toLowerCase();
      if (['opus','webm'].includes(ext)) continue;
      const bl=buildLabel(item);
      if (seenL[bl.label]) continue;
      seenL[bl.label]=true;
      medias.push({url:item.url,quality:`${bl.icon} ${bl.label}`,ext:bl.ext,stream:true});
    }
    medias.sort((a,b)=>a.quality.includes('🎵')&&!b.quality.includes('🎵')?1:!a.quality.includes('🎵')&&b.quality.includes('🎵')?-1:0);
    return res.json({success:true,platform,title,thumb,medias});

  } catch(e) {
    return res.json({success:false,error:'Server error: '+e.message});
  }
});

app.get('/',(req,res)=>res.json({status:'VidSave Pro API v3',ok:true}));
app.get('/health',(req,res)=>res.json({ok:true}));
app.listen(PORT,()=>console.log(`VidSave Pro API running on port ${PORT}`));
