/**
 * FBDown – Server dùng yt-dlp (v3)
 * Chạy: node server.js  hoặc  npm start
 * Truy cập: http://localhost:3000
 */

const express  = require('express');
const { spawn } = require('child_process');
const path     = require('path');
const fs       = require('fs');

const app      = express();
// Tự động chọn yt-dlp theo OS
// Windows: dùng yt-dlp.exe cùng thư mục
// Linux (Render/server): dùng /usr/local/bin/yt-dlp
const IS_WINDOWS = process.platform === 'win32';
const YTDLP = IS_WINDOWS
  ? path.join(__dirname, 'yt-dlp.exe')
  : (process.env.YTDLP_PATH || 'yt-dlp');

const PORT = process.env.PORT || 3000;

// ── Serve static files ───────────────────────
app.use(express.static(path.join(__dirname)));

// ── Helper: chạy yt-dlp và trả JSON ──────────
function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    const proc = spawn(YTDLP, args, { windowsHide: true });

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('yt-dlp timeout (30s)'));
    }, 30000);

    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0 || stdout.trim()) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr.trim() || `exit code ${code}`));
      }
    });

    proc.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ── API: lấy thông tin video ─────────────────
app.get('/api/get-video', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const videoUrl = (req.query.url || '').trim();
  if (!videoUrl) {
    return res.status(400).json({ success: false, error: 'Thiếu tham số url' });
  }

  console.log(`\n[→] Xử lý: ${videoUrl}`);

  try {
    // Bước 1: Lấy JSON metadata từ yt-dlp (không tải file)
    const jsonStr = await runYtDlp([
      '--dump-json',
      '--no-playlist',
      '--no-warnings',
      '--no-check-certificates',   // bỏ qua SSL verify
      '--socket-timeout', '20',
      videoUrl,
    ]);

    const info = JSON.parse(jsonStr);
    console.log(`[✓] Tìm thấy: "${info.title}"`);

    // Bước 2: Lấy các format available
    const formats = info.formats || [];

    // Lọc video formats (có video stream, không phải audio only)
    const videoFormats = formats.filter(f =>
      f.vcodec && f.vcodec !== 'none' &&
      f.url && f.url.startsWith('http')
    );

    // Sắp xếp theo chất lượng (height giảm dần)
    videoFormats.sort((a, b) => (b.height || 0) - (a.height || 0));

    let hd = null;
    let sd = null;

    if (videoFormats.length >= 1) {
      const best = videoFormats[0];
      hd = {
        url:   best.url,
        label: best.height ? `${best.height}p` : 'HD',
        size:  best.height ? `${best.height}p – Chất lượng cao` : 'Chất lượng cao',
      };
    }

    if (videoFormats.length >= 2) {
      // Tìm format thấp hơn (360p hoặc 480p)
      const lower = videoFormats.find(f => f.height && f.height <= 480) || videoFormats[videoFormats.length - 1];
      if (lower && lower.url !== hd?.url) {
        sd = {
          url:   lower.url,
          label: lower.height ? `${lower.height}p` : 'SD',
          size:  lower.height ? `${lower.height}p – Chất lượng thường` : 'Chất lượng thường',
        };
      }
    }

    // Nếu không có format riêng, dùng best URL
    if (!hd) {
      // Thử lấy direct URL
      const directUrl = await runYtDlp([
        '--get-url',
        '--no-playlist',
        '--format', 'best',
        '--no-warnings',
        '--no-check-certificates',
        videoUrl,
      ]);
      const urls = directUrl.split('\n').filter(u => u.startsWith('http'));
      if (urls.length > 0) hd = { url: urls[0], label: 'HD', size: 'Chất lượng cao' };
      if (urls.length > 1) sd = { url: urls[1], label: 'SD', size: 'Chất lượng thường' };
    }

    if (!hd && !sd) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy link video.' });
    }

    return res.json({
      success:   true,
      source:    'yt-dlp',
      title:     info.title     || 'Facebook Video',
      thumbnail: info.thumbnail || null,
      duration:  info.duration  || null,
      hd,
      sd,
    });

  } catch (err) {
    console.error(`[✗] Lỗi: ${err.message}`);

    // Phân tích lỗi để trả thông báo thân thiện
    let friendlyError = 'Không thể lấy video.';
    const msg = err.message.toLowerCase();

    if (msg.includes('private') || msg.includes('login') || msg.includes('not available')) {
      friendlyError = 'Video này ở chế độ riêng tư hoặc yêu cầu đăng nhập Facebook.';
    } else if (msg.includes('not found') || msg.includes('does not exist') || msg.includes('removed')) {
      friendlyError = 'Video không tồn tại hoặc đã bị xóa.';
    } else if (msg.includes('timeout')) {
      friendlyError = 'Hết thời gian chờ. Thử lại sau.';
    } else if (msg.includes('network') || msg.includes('connection')) {
      friendlyError = 'Lỗi kết nối mạng. Kiểm tra internet rồi thử lại.';
    }

    return res.status(500).json({ success: false, error: friendlyError, detail: err.message });
  }
});

// ── API: Stream download qua yt-dlp ──────────
// yt-dlp tải video rồi pipe thẳng về browser
// Endpoint: /api/download?url=FACEBOOK_URL&q=hd|sd&name=filename.mp4
app.get('/api/download', async (req, res) => {
  const fbUrl   = (req.query.url  || '').trim();
  const quality = (req.query.q   || 'best').trim();
  const safeName = (req.query.name || 'facebook_video.mp4').replace(/[^a-zA-Z0-9._\-]/g, '_');

  if (!fbUrl) return res.status(400).send('Missing url');

  console.log(`[⬇] Download ${quality.toUpperCase()}: ${fbUrl}`);

  // Chọn format: single mp4 file (không merge) → tránh ffmpeg dependency
  // 'best[ext=mp4]' = file mp4 đơn chứa cả video+audio (không cần merge)
  let fmt;
  if (quality === 'sd') {
    fmt = 'worst[ext=mp4]/worst';
  } else {
    fmt = 'best[ext=mp4]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best';
  }

  // Tạo tên file tạm thời
  const tmpFile = path.join(require('os').tmpdir(), `fbdown_${Date.now()}.mp4`);

  const args = [
    '--no-check-certificates',
    '--no-warnings',
    '--no-playlist',
    '--format', fmt,
    '-o', tmpFile,
    fbUrl,
  ];

  console.log(`  [args] ${args.join(' ')}`);

  const proc = spawn(YTDLP, args, { windowsHide: true });

  proc.stderr.on('data', d => {
    const line = d.toString().trim();
    if (line) console.log(`  [yt-dlp] ${line}`);
  });

  proc.on('error', err => {
    console.error('[⬇ ERR]', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  });

  proc.on('close', code => {
    if (code !== 0) {
      console.error(`[⬇ FAIL] exit=${code}`);
      if (!res.headersSent) res.status(500).json({ error: 'yt-dlp failed', code });
      return;
    }

    // Kiểm tra file tồn tại (yt-dlp có thể đổi extension)
    let actualFile = tmpFile;
    if (!fs.existsSync(actualFile)) {
      // Thử tìm file gần giống
      const dir  = require('os').tmpdir();
      const base = path.basename(tmpFile, '.mp4');
      const files = fs.readdirSync(dir).filter(f => f.startsWith(base));
      if (files.length > 0) actualFile = path.join(dir, files[0]);
    }

    if (!fs.existsSync(actualFile)) {
      console.error('[⬇ FAIL] File không tồn tại:', actualFile);
      if (!res.headersSent) res.status(500).json({ error: 'File not found after download' });
      return;
    }

    const stat = fs.statSync(actualFile);
    console.log(`[⬇ STREAM] ${actualFile} (${(stat.size/1024/1024).toFixed(1)} MB)`);

    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', stat.size);

    const stream = fs.createReadStream(actualFile);
    stream.pipe(res);

    stream.on('end', () => {
      // Xóa file tạm sau khi stream xong
      fs.unlink(actualFile, () => {});
      console.log(`[⬇ DONE] Streamed & deleted tmp file`);
    });

    stream.on('error', e => {
      console.error('[⬇ STREAM ERR]', e.message);
      fs.unlink(actualFile, () => {});
      res.end();
    });

    req.on('close', () => {
      stream.destroy();
      fs.unlink(actualFile, () => {});
      console.log('[⬇ ABORT] Client disconnected, tmp deleted');
    });
  });
});



// ── Start ─────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║      🎬 FBDown Server v3 đang chạy!      ║');
  console.log(`║   → Mở trình duyệt: http://localhost:${PORT}  ║`);
  console.log('║   → Dùng yt-dlp để tải video Facebook   ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');

  // Kiểm tra yt-dlp tồn tại
  if (!fs.existsSync(YTDLP)) {
    console.error('⚠️  CẢNH BÁO: Không tìm thấy yt-dlp.exe!');
    console.error(`    Đặt yt-dlp.exe vào: ${YTDLP}`);
  } else {
    console.log(`✅ yt-dlp.exe: ${YTDLP}`);
  }
  console.log('');
});
