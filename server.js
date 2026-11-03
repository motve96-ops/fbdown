/**
 * FBDown – Server dùng yt-dlp & ffmpeg
 * Tối ưu hóa hiệu năng, chống crash và quản lý tiến trình an toàn
 */

const express = require('express');
const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ── 0. BẢO VỆ TOÀN CỤC CHỐNG CRASH SERVER ─────────────────────
process.on('uncaughtException', (err) => {
  console.error('[FATAL CAUGHT] Uncaught Exception:', err.message, err.stack);
  // Không exit để server duy trì hoạt động phục vụ người dùng
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL CAUGHT] Unhandled Rejection:', reason);
});

const app = express();
const PORT = process.env.PORT || 3000;
const IS_WINDOWS = process.platform === 'win32';

const YTDLP = IS_WINDOWS
  ? path.join(__dirname, 'yt-dlp.exe')
  : (process.env.YTDLP_PATH || 'yt-dlp');

const FFMPEG = IS_WINDOWS
  ? path.join(__dirname, 'ffmpeg.exe')
  : (process.env.FFMPEG_PATH || 'ffmpeg');

const COOKIES_FILE = path.join(__dirname, 'cookies.txt');

// ── 1. THƯ MỤC TẠM AN TOÀN VỚI CƠ CHẾ FALLBACK ──────────────
function resolveTempDir() {
  const preferred = IS_WINDOWS ? 'D:\\FBDownTemp' : path.join(os.tmpdir(), 'fbdown');
  try {
    if (!fs.existsSync(preferred)) {
      fs.mkdirSync(preferred, { recursive: true });
    }
    // Kiểm tra quyền ghi
    const testFile = path.join(preferred, `.test_${Date.now()}`);
    fs.writeFileSync(testFile, 'ok');
    fs.unlinkSync(testFile);
    return preferred;
  } catch (e) {
    console.warn(`[!] Không thể ghi vào ${preferred}, chuyển sang thư mục cục bộ ./temp:`, e.message);
    const fallback = path.join(__dirname, 'temp');
    if (!fs.existsSync(fallback)) {
      try { fs.mkdirSync(fallback, { recursive: true }); } catch (_) {}
    }
    return fallback;
  }
}

const TMP_DIR = resolveTempDir();

// Hàm diệt tiến trình triệt để trên Windows và Linux
function killProcessTree(proc) {
  if (!proc || !proc.pid) return;
  try {
    if (IS_WINDOWS) {
      exec(`taskkill /pid ${proc.pid} /t /f`, () => {});
    } else {
      proc.kill('SIGKILL');
    }
  } catch (err) {
    console.warn('[!] Không thể kill pid:', proc.pid, err.message);
  }
}

// Map quản lý jobs có TTL và trạng thái tiến trình
const jobs = new Map();
// Cache lưu thông tin loại video (livestream kết thúc, tiêu đề) để tối ưu luồng tải
const videoMetaCache = new Map();

// ── 2. DỌN DẸP FILE TẠM ĐỊNH KỲ ──────────────────────────────
function cleanupOldTempFiles(maxAgeMs = 2 * 60 * 60 * 1000) {
  try {
    if (!fs.existsSync(TMP_DIR)) return;
    const now = Date.now();
    const files = fs.readdirSync(TMP_DIR);

    // Thu thập danh sách tiền tố file của các job đang thực thi để không xóa nhầm
    const activePrefixes = [];
    for (const [id, job] of jobs.entries()) {
      if (job.status === 'starting' || job.status === 'downloading' || job.status === 'merging') {
        activePrefixes.push(`fbdown_${id}`);
      }
    }

    for (const file of files) {
      if (file.startsWith('fbdown_')) {
        // Bỏ qua nếu job này vẫn đang chạy
        const isRunning = activePrefixes.some(prefix => file.startsWith(prefix));
        if (isRunning) continue;

        const fullPath = path.join(TMP_DIR, file);
        try {
          const stats = fs.statSync(fullPath);
          if (now - stats.mtimeMs > maxAgeMs) {
            fs.unlinkSync(fullPath);
            console.log(`[🧹] Đã dọn file tạm cũ: ${file}`);
          }
        } catch (_) {}
      }
    }
  } catch (err) {
    console.warn('[!] Lỗi dọn file tạm:', err.message);
  }
}

// Dọn dẹp định kỳ mỗi 15 phút (chỉ xóa file cũ hơn 2 tiếng và không thuộc job đang chạy)
setInterval(() => cleanupOldTempFiles(), 15 * 60 * 1000);
// Dọn dẹp file cũ khi khởi động (chỉ xóa file cũ hơn 1 tiếng)
cleanupOldTempFiles(60 * 60 * 1000);

// ── 3. MIDDLEWARE & STATIC ──────────────────────────────────
app.use(express.static(path.join(__dirname)));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// ── 4. HELPER: CHUẨN HÓA URL YOUTUBE ─────────────────────────
// Chuyển /live/ID, /shorts/ID về dạng watch?v=ID để yt-dlp xử lý đúng
function normalizeYouTubeUrl(url) {
  try {
    const u = new URL(url);
    // youtube.com/live/VIDEO_ID hoặc /shorts/VIDEO_ID
    const pathMatch = u.pathname.match(/\/(live|shorts)\/([a-zA-Z0-9_-]+)/);
    if (pathMatch) {
      return `https://www.youtube.com/watch?v=${pathMatch[2]}`;
    }
    // youtu.be/VIDEO_ID
    if (u.hostname === 'youtu.be') {
      const vid = u.pathname.replace(/^\//, '');
      if (vid) return `https://www.youtube.com/watch?v=${vid}`;
    }
  } catch (_) {}
  return url;
}

// ── 4b. HELPER: CHẠY YT-DLP AN TOÀN CHO METADATA ─────────────
function runYtDlp(args, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    let proc;
    try {
      proc = spawn(YTDLP, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (spawnErr) {
      return reject(spawnErr);
    }

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        killProcessTree(proc);
        reject(new Error('Hết thời gian chờ phản hồi từ yt-dlp (timeout)'));
      }
    }, timeoutMs);

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.stdout.on('error', () => {});
    proc.stderr.on('error', () => {});

    proc.on('error', err => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        killProcessTree(proc);
        reject(err);
      }
    });

    proc.on('close', code => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (code === 0 || stdout.trim()) {
          resolve(stdout.trim());
        } else {
          reject(new Error(stderr.trim() || `Exit code ${code}`));
        }
      }
    });
  });
}

// ── 5. API: LẤY THÔNG TIN VIDEO ──────────────────────────────
app.get('/api/get-video', async (req, res) => {
  let videoUrl = (req.query.url || '').trim();
  if (!videoUrl) {
    return res.status(400).json({ success: false, error: 'Vui lòng cung cấp link video hợp lệ.' });
  }

  const isYouTube = /youtube\.com|youtu\\.be/.test(videoUrl);
  const isFacebook = /facebook\.com|fb\.watch|fb\.com/.test(videoUrl);

  // Chuẩn hóa URL YouTube: /live/ID, /shorts/ID → watch?v=ID
  if (isYouTube) videoUrl = normalizeYouTubeUrl(videoUrl);

  const sourceName = isYouTube ? 'YouTube' : isFacebook ? 'Facebook' : 'Video';
  console.log(`\n[→] Phân tích link (${sourceName}): ${videoUrl}`);

  try {
    // Hàm tạo args cơ bản dùng chung
    const baseArgs = (extra = []) => {
      const a = [
        '--dump-json',
        '--no-playlist',
        '--no-warnings',
        '--no-check-certificates',
        '--no-cache-dir',
        '--socket-timeout', '20',
        ...extra,
      ];
      if (isYouTube) a.push('--js-runtimes', 'node');
      if (isFacebook) a.push('--extractor-args', 'facebook:api=api');
      if (fs.existsSync(COOKIES_FILE)) a.push('--cookies', COOKIES_FILE);
      a.push(videoUrl);
      return a;
    };

    let jsonStr;

    if (!isYouTube) {
      // Không phải YouTube → chạy thẳng
      jsonStr = await runYtDlp(baseArgs());
    } else {
      // Danh sách client YouTube tốc độ cao
      const clientStrategies = [
        { label: 'Web (mặc định)',   extra: [] },
        { label: 'VisionOS',         extra: ['--extractor-args', 'youtube:player_client=visionos'] },
        { label: 'Android',          extra: ['--extractor-args', 'youtube:player_client=android'] },
        { label: 'Web Embedded (dự phòng)', extra: ['--extractor-args', 'youtube:player_client=web_embedded,web'] },
      ];

      let lastErr = null;
      for (const strategy of clientStrategies) {
        try {
          console.log(`[→] Thử client YouTube: ${strategy.label}`);
          jsonStr = await runYtDlp(baseArgs(strategy.extra));
          console.log(`[✓] Thành công với client: ${strategy.label}`);
          break;
        } catch (err) {
          lastErr = err;
          const m = (err.message || '').toLowerCase();
          // Tiếp tục thử client khác nếu gặp lỗi liên quan đến giới hạn/bot/live
          if (m.includes('bot') || m.includes('sign in') || m.includes('429')
              || m.includes('po token') || m.includes('manifestless')
              || m.includes('this live event has ended')
              || m.includes('format is not available')) {
            console.log(`[!] Client ${strategy.label} thất bại, thử tiếp...`);
            continue;
          }
          throw err;
        }
      }

      if (!jsonStr) {
        throw lastErr || new Error('Tất cả YouTube clients đều thất bại');
      }
    }

    const info = JSON.parse(jsonStr);
    console.log(`[✓] Nhận diện thành công: "${info.title || 'Không có tiêu đề'}"`);

    const formats = info.formats || [];

    // Lọc các format có video
    const allVideoFmts = formats.filter(f =>
      f.vcodec && f.vcodec !== 'none' && f.url && f.url.startsWith('http')
    );

    // Sắp xếp độ phân giải cao → thấp
    allVideoFmts.sort((a, b) => {
      const ah = (a.height || 0) * (a.width || 1);
      const bh = (b.height || 0) * (b.width || 1);
      return bh - ah;
    });

    const bestFmt = allVideoFmts[0];
    const sdFmt = allVideoFmts.find(f => f.height && f.height <= 480)
      || allVideoFmts[allVideoFmts.length - 1];

    const fbHd = formats.find(f => f.format_id === 'hd');
    const fbSd = formats.find(f => f.format_id === 'sd');

    let hd = null;
    let sd = null;

    if (bestFmt) {
      const h = bestFmt.height || 0;
      const resLabel = h > 0 ? `${h}p` : 'HD';
      hd = {
        label: resLabel,
        size: `${resLabel} – Độ phân giải cao nhất`,
      };
    } else if (fbHd) {
      hd = { label: 'HD', size: 'HD – Chất lượng cao' };
    }

    if (sdFmt && (sdFmt.format_id !== bestFmt?.format_id)) {
      const h = sdFmt.height || 0;
      const resLabel = h > 0 ? `${h}p` : 'SD';
      sd = {
        label: resLabel,
        size: `${resLabel} – Tiết kiệm dung lượng`,
      };
    } else if (fbSd) {
      sd = { label: 'SD', size: 'SD – Chất lượng thường' };
    }

    // Nếu chỉ có 1 format
    if (!hd && !sd && allVideoFmts.length > 0) {
      hd = { label: 'Best', size: 'Chất lượng tiêu chuẩn' };
    }

    if (!hd && !sd) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy định dạng video phù hợp để tải về.' });
    }

    // Định dạng thời lượng
    let durationFormatted = null;
    if (info.duration) {
      const m = Math.floor(info.duration / 60);
      const s = Math.floor(info.duration % 60);
      durationFormatted = `${m}:${s < 10 ? '0' : ''}${s}`;
    }

    // Nhận diện video có phải là Livestream vừa kết thúc không
    const isPostLive = !!(info.is_live || info.was_live || info.live_status === 'post_live' || info.live_status === 'is_live');
    videoMetaCache.set(videoUrl, { isPostLive, title: info.title });
    if (isPostLive) {
      console.log(`[⚡ Post-Live] Đã nhận diện video livestream kết thúc: "${info.title}"`);
    }

    return res.json({
      success: true,
      source: sourceName,
      title: info.title || `${sourceName} Video`,
      thumbnail: info.thumbnail || null,
      duration: durationFormatted,
      isPostLive,
      hd,
      sd,
    });

  } catch (err) {
    console.error(`[✗] Lỗi phân tích: ${err.message}`);
    let friendlyError = 'Không thể lấy dữ liệu video này.';
    const msg = (err.message || '').toLowerCase();

    if (msg.includes('live event has ended')) {
      friendlyError = 'Sự kiện trực tiếp (Live) này đã kết thúc. YouTube đang xử lý lưu trữ lại video, bạn vui lòng đợi ít phút rồi thử lại nhé!';
    } else if (msg.includes('live stream recording is not available') || msg.includes('recording is not available')) {
      friendlyError = 'Video phát trực tiếp này không có bản ghi xem lại hoặc chưa được công khai.';
    } else if (msg.includes('confirm you’re not a bot') || msg.includes('confirm youre not a bot') || msg.includes('sign in to confirm you') || (msg.includes('429') && isYouTube)) {
      friendlyError = 'YouTube đang chặn bot tự động hoặc giới hạn lượt truy vấn. Bạn hãy đặt file cookies.txt của YouTube vào thư mục server để tiếp tục!';
    } else if (msg.includes('members only') || msg.includes('member-only') || msg.includes('hội viên')) {
      friendlyError = 'Video này chỉ dành riêng cho hội viên có trả phí của kênh.';
    } else if (msg.includes('age') && (msg.includes('restricted') || msg.includes('confirm'))) {
      friendlyError = 'Video giới hạn độ tuổi người xem (18+), yêu cầu có cookies.txt để xác thực.';
    } else if (msg.includes('private')) {
      friendlyError = `Video này được chủ sở hữu đặt ở chế độ riêng tư trên ${sourceName}.`;
    } else if (msg.includes('sign in') || msg.includes('login') || msg.includes('đăng nhập')) {
      friendlyError = `Video này yêu cầu đăng nhập tài khoản ${sourceName}.`;
    } else if (msg.includes('not found') || msg.includes('does not exist') || msg.includes('removed') || msg.includes('deleted')) {
      friendlyError = 'Video không tồn tại hoặc đã bị gỡ bỏ.';
    } else if (msg.includes('timeout')) {
      friendlyError = 'Thời gian kết nối quá lâu. Vui lòng bấm thử lại!';
    } else if (msg.includes('network') || msg.includes('connection')) {
      friendlyError = 'Lỗi mạng kết nối đến máy chủ lưu video. Vui lòng kiểm tra internet.';
    }

    return res.status(500).json({ success: false, error: friendlyError, detail: err.message });
  }
});

// ── 6. STATE MANAGEMENT & DOWNLOAD CONCURRENCY ──────────────
const MAX_CONCURRENT_DOWNLOADS = 2;

function getActiveDownloadCount() {
  let count = 0;
  for (const job of jobs.values()) {
    if (job.status === 'downloading' || job.status === 'starting' || job.status === 'merging') {
      count++;
    }
  }
  return count;
}

// Tự động dọn dẹp job cũ trong RAM
function registerJobCleanup(jobId, delayMs = 60 * 60 * 1000) {
  setTimeout(() => {
    const job = jobs.get(jobId);
    if (job) {
      // Nếu job vẫn đang chạy thì chưa được xóa
      if (job.status === 'starting' || job.status === 'downloading' || job.status === 'merging') {
        return;
      }
      if (job.file && fs.existsSync(job.file)) {
        try { fs.unlinkSync(job.file); } catch (_) {}
      }
      jobs.delete(jobId);
    }
  }, delayMs);
}

// ── 7. HÀM TẠO ARGS CHO YT-DLP (TỐI ĐA HÓA BĂNG THÔNG) ───────
function buildYtDlpArgs({ tmpFile, fmt, isYouTube, isFacebook, videoUrl, useFallback = false, retryMode = false }) {
  const args = [
    '--no-check-certificates',
    '--no-warnings',
    '--no-playlist',
    '--no-cache-dir',
    '--no-mtime',
    '--continue',
    '--newline',
    '-o', tmpFile
  ];

  if (useFallback) {
    // Chế độ dự phòng cho video lỗi / livestream vừa kết thúc
    args.push(
      '--socket-timeout', '30',
      '--retries', '15',
      '--fragment-retries', '15',
      '--file-access-retries', '10',
      '--extractor-retries', '5',
      '--skip-unavailable-fragments',
      '--concurrent-fragments', '10',
      '--format', fmt,
      '--merge-output-format', 'mp4'
    );
    console.log(`  [🛡️ Fallback/Post-Live] Chế độ Dự phòng cho Livestream vừa kết thúc (10 fragments + web_embedded)`);
  } else if (retryMode) {
    // Retry mode: tải an toàn khi gặp sự cố, giữ nguyên các fragment đã tải để resume
    args.push(
      '--socket-timeout', '60',
      '--retries', '20',
      '--fragment-retries', '20',
      '--file-access-retries', '15',
      '--extractor-retries', '10',
      '--skip-unavailable-fragments',
      '--concurrent-fragments', '8',
      '--format', fmt,
      '--merge-output-format', 'mp4'
    );
    console.log(`  [🔄 Retry] Chế độ tải an toàn (8 fragments, 20 retries, giữ nguyên mảnh đã tải)`);
  } else {
    // 🚀 TỐC ĐỘ TỐI ĐA: Client tự do, không ép web_embedded, max băng thông mạng
    args.push(
      '--socket-timeout', '30',
      '--retries', '10',
      '--fragment-retries', '10',
      '--file-access-retries', '10',
      '--extractor-retries', '5',
      '--skip-unavailable-fragments',
      '--concurrent-fragments', '16',
      '--buffer-size', '16M',
      '--throttled-rate', '100K',
      '--format', fmt,
      '--merge-output-format', 'mp4'
    );
    console.log(`  [🚀 Tốc độ tối đa] Client tự do, max băng thông (16 fragments, buffer 16M)`);
  }

  if (isFacebook) {
    args.push('--extractor-args', 'facebook:api=api');
  } else if (isYouTube) {
    args.push('--js-runtimes', 'node');
    if (useFallback) {
      args.push('--extractor-args', 'youtube:player_client=web_embedded,web');
    }
  }

  if (fs.existsSync(COOKIES_FILE)) {
    args.push('--cookies', COOKIES_FILE);
  }

  if (fs.existsSync(FFMPEG)) {
    args.push('--ffmpeg-location', FFMPEG);
  }

  args.push(videoUrl);
  return args;
}

// ── 7b. HÀM CHẠY DOWNLOAD (hỗ trợ auto-retry & auto-resume) ──
function runDownload({ job, jobId, tmpFile, fmt, isYouTube, isFacebook, videoUrl, useFallback = false, retryMode = false }) {
  const attempt = retryMode ? 2 : 1;
  const maxAttempts = 2;

  // Khi retry: KHÔNG xóa file tạm để yt-dlp tiếp tục resume tải các mảnh còn thiếu, tránh tải lại từ đầu tốn thời gian
  if (retryMode) {
    job.status = 'starting';
    job.detail = useFallback
      ? `Đang thử lại với Chế độ Dự phòng (Web Embedded)...`
      : `Đang tiếp tục tải (lần ${attempt})... Chế độ an toàn`;
    job.error = null;
  }

  const args = buildYtDlpArgs({ tmpFile, fmt, isYouTube, isFacebook, videoUrl, useFallback, retryMode });

  let proc;
  try {
    proc = spawn(YTDLP, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    job.proc = proc;
  } catch (spawnErr) {
    job.status = 'error';
    job.error = `Không thể khởi động tiến trình tải: ${spawnErr.message}`;
    return;
  }

  // Timeout tối đa cho mỗi tác vụ download (3 tiếng cho video dài / livestream)
  const jobTimeout = setTimeout(() => {
    if (job.status !== 'done' && job.status !== 'error') {
      console.warn(`[⏰] Job ${jobId} (lần ${attempt}) quá 3 giờ, đang tự hủy...`);
      killProcessTree(proc);
      job.status = 'error';
      job.error = 'Thời gian tải vượt quá giới hạn tối đa (3 giờ).';
      registerJobCleanup(jobId, 15 * 60 * 1000);
    }
  }, 180 * 60 * 1000);

  // QUAN TRỌNG: Bắt buộc phải có proc.on('error') để tránh sập server!
  proc.on('error', (err) => {
    clearTimeout(jobTimeout);
    console.error(`[✗] Lỗi tiến trình Job ${jobId} (lần ${attempt}):`, err.message);
    job.status = 'error';
    job.error = 'Lỗi tiến trình yt-dlp: ' + err.message;
    registerJobCleanup(jobId, 30 * 60 * 1000);
  });

  proc.stdout.on('data', d => {
    const text = d.toString();
    const lines = text.split(/[\r\n]+/);
    for (const line of lines) {
      if (line.includes('[download]') && line.includes('%')) {
        const pctMatches = [...line.matchAll(/(\d+(?:\.\d+)?)%/g)];
        if (pctMatches.length > 0) {
          const latestPct = pctMatches[pctMatches.length - 1][1];
          job.status = 'downloading';
          job.progress = `${latestPct}%`;

          const speedMatches = [...line.matchAll(/at\s+([\d.]+\s*[KMG]?i?B\/s)/gi)];
          const etaMatches = [...line.matchAll(/ETA\s+([\d:]+|Unknown)/gi)];
          const fragMatches = [...line.matchAll(/\(frag\s+(\d+\/\d+)\)/gi)];

          let details = [];
          if (retryMode) details.push('🔄 Retry');
          if (speedMatches.length > 0) details.push(`Tốc độ: ${speedMatches[speedMatches.length - 1][1]}`);
          if (etaMatches.length > 0 && etaMatches[etaMatches.length - 1][1] !== 'Unknown') details.push(`Còn lại: ${etaMatches[etaMatches.length - 1][1]}`);
          if (fragMatches.length > 0) details.push(`Mảnh: ${fragMatches[fragMatches.length - 1][1]}`);

          job.detail = details.length > 0 ? details.join(' • ') : 'Đang tải phân đoạn...';
        }
      } else if (line.includes('[Merger]') || line.includes('Merging formats')) {
        job.status = 'merging';
        job.progress = '95%';
        job.detail = 'Đang ghép video & audio bằng FFmpeg...';
      }
    }
  });

  let stderrBuffer = '';
  proc.stderr.on('data', d => {
    const text = d.toString();
    stderrBuffer += text;
    const errText = text.trim();
    if (errText) {
      console.log(`  [yt-dlp log ${jobId}]: ${errText.slice(0, 150)}`);
    }
  });

  proc.stdout.on('error', () => {});
  proc.stderr.on('error', () => {});

  proc.on('close', code => {
    clearTimeout(jobTimeout);
    job.proc = null;

    if (job.status === 'canceled') {
      return;
    }

    if (code !== 0) {
      const cleanErr = stderrBuffer.trim().split('\n').filter(l => l.includes('ERROR:')).pop() || `Mã lỗi ${code}`;
      let friendlyDownloadErr = cleanErr.replace('ERROR:', '').trim();
      const lower = friendlyDownloadErr.toLowerCase();

      // ── AUTO-RETRY: nếu lỗi "downloaded file is empty", lỗi fragment, lỗi live kết thúc và chưa retry ──
      const isEmptyFileErr = lower.includes('downloaded file is empty') || lower.includes('file is empty');
      const isFragmentErr = lower.includes('giving up after') || lower.includes('unable to download') || lower.includes('no such file or directory');
      const isLiveEndedErr = lower.includes('this live event has ended') || lower.includes('live event has ended');

      if ((isEmptyFileErr || isFragmentErr || isLiveEndedErr) && !retryMode && attempt < maxAttempts) {
        console.log(`[🔄] Job ${jobId}: Lỗi "${friendlyDownloadErr}" → Tự động tiếp tục retry với Chế độ Dự phòng (Web Embedded)...`);
        // Retry với format fallback an toàn hơn cho video post_live
        let retryFmt = fmt;
        if (isYouTube) {
          retryFmt = fmt.includes('height<=480')
            ? 'worstvideo[height>=360][vcodec^=avc1]+bestaudio[acodec^=mp4a]/worst'
            : 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';
          console.log(`  [🔄] Retry format: ${retryFmt}`);
        }
        // Đợi 2 giây rồi retry với web_embedded
        setTimeout(() => {
          runDownload({ job, jobId, tmpFile, fmt: retryFmt, isYouTube, isFacebook, videoUrl, useFallback: isYouTube, retryMode: true });
        }, 2000);
        return;
      }

      // Thông báo lỗi thân thiện
      if (lower.includes('live event has ended')) {
        friendlyDownloadErr = 'Video livestream này vừa kết thúc nên YouTube chặn tải tốc độ thường. Hãy bấm nút "Tải bằng Chế độ Dự phòng" bên dưới nhé!';
        job.suggestFallback = true;
      } else if (lower.includes('bot') || lower.includes('sign in')) {
        friendlyDownloadErr = 'YouTube yêu cầu xác thực bot hoặc thêm cookies.txt.';
      } else if (isEmptyFileErr) {
        friendlyDownloadErr = 'File tải về bị rỗng (do livestream vừa kết thúc). Hãy bấm nút "Tải bằng Chế độ Dự phòng" bên dưới nhé!';
        job.suggestFallback = true;
      }

      job.status = 'error';
      job.error = `Lỗi tải: ${friendlyDownloadErr}`;
      registerJobCleanup(jobId, 30 * 60 * 1000);
      return;
    }

    try {
      let actualFile = tmpFile;
      if (!fs.existsSync(actualFile)) {
        const base = path.basename(tmpFile, '.mp4');
        if (fs.existsSync(TMP_DIR)) {
          const files = fs.readdirSync(TMP_DIR).filter(f => f.startsWith(base));
          if (files.length > 0) {
            actualFile = path.join(TMP_DIR, files[0]);
          }
        }
      }

      if (!fs.existsSync(actualFile)) {
        job.status = 'error';
        job.error = 'Không tìm thấy file sau khi tải xong.';
        registerJobCleanup(jobId, 30 * 60 * 1000);
        return;
      }

      // Kiểm tra file có thực sự có dữ liệu không
      const fileSize = fs.statSync(actualFile).size;
      if (fileSize === 0) {
        // File rỗng → xóa và retry nếu có thể
        try { fs.unlinkSync(actualFile); } catch (_) {}
        if (!retryMode && attempt < maxAttempts) {
          console.log(`[🔄] Job ${jobId}: File kết quả rỗng (0 bytes) → Tự động retry với Chế độ Dự phòng (Web Embedded)...`);
          let retryFmt = fmt;
          if (isYouTube) {
            retryFmt = fmt.includes('height<=480')
              ? 'worstvideo[height>=360][vcodec^=avc1]+bestaudio[acodec^=mp4a]/worst'
              : 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';
          }
          setTimeout(() => {
            runDownload({ job, jobId, tmpFile, fmt: retryFmt, isYouTube, isFacebook, videoUrl, useFallback: isYouTube, retryMode: true });
          }, 3000);
          return;
        }
        job.status = 'error';
        job.suggestFallback = isYouTube;
        job.error = 'File tải về bị rỗng (video có thể là livestream vừa kết thúc). Hãy bấm vào nút "Tải bằng Chế độ Dự phòng" bên dưới để tải ngay!';
        registerJobCleanup(jobId, 30 * 60 * 1000);
        return;
      }

      job.status = 'done';
      job.progress = '100%';
      job.file = actualFile;
      const sizeMB = (fileSize / 1024 / 1024).toFixed(1);
      console.log(`[⬇ DONE] Job ${jobId} hoàn thành: ${actualFile} (${sizeMB} MB)${retryMode ? ' [sau retry]' : ''}`);
      registerJobCleanup(jobId, 60 * 60 * 1000); // Lưu giữ 60 phút để người dùng tải
    } catch (fsErr) {
      console.error('[!] Lỗi kiểm tra file hoàn thành:', fsErr.message);
      job.status = 'error';
      job.error = 'Lỗi xử lý file thành phẩm: ' + fsErr.message;
      registerJobCleanup(jobId, 30 * 60 * 1000);
    }
  });
}

// ── 7c. API BẮT ĐẦU TẢI ───────────────────────────────────────
app.get('/api/start-download', async (req, res) => {
  let videoUrl = (req.query.url || '').trim();
  const quality = (req.query.q || 'hd').trim().toLowerCase();
  let safeName = (req.query.name || 'video.mp4')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim();
  if (!safeName.endsWith('.mp4')) safeName += '.mp4';

  if (!videoUrl) {
    return res.status(400).json({ success: false, error: 'Thiếu đường dẫn video.' });
  }

  const isYouTube = /youtube\.com|youtu\.be/.test(videoUrl);
  const isFacebook = /facebook\.com|fb\.watch|fb\.com/.test(videoUrl);

  // Chuẩn hóa URL YouTube: /live/ID, /shorts/ID → watch?v=ID
  if (isYouTube) videoUrl = normalizeYouTubeUrl(videoUrl);

  // Kiểm tra nếu video này đang được tải trong hệ thống thì trả về jobId hiện tại, tránh trùng lặp chiếm băng thông
  for (const [id, j] of jobs.entries()) {
    if (j.videoUrl === videoUrl && j.quality === quality && (j.status === 'starting' || j.status === 'downloading' || j.status === 'merging')) {
      console.log(`[ℹ] Video đang được tải trong tiến trình khác, kết nối lại Job ${id}`);
      return res.json({ success: true, jobId: id });
    }
  }

  // Kiểm tra giới hạn tiến trình tải đồng thời
  if (getActiveDownloadCount() >= MAX_CONCURRENT_DOWNLOADS) {
    return res.status(429).json({
      success: false,
      error: 'Máy chủ đang xử lý tối đa 2 tác vụ tải cùng lúc. Vui lòng đợi trong giây lát rồi nhấn lại!'
    });
  }

  const jobId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  const tmpFile = path.join(TMP_DIR, `fbdown_${jobId}.mp4`);

  // Format selection – ưu tiên mp4/avc1 để tránh lỗi với video post_live (livestream đã kết thúc)
  let fmt;
  if (quality === 'sd') {
    fmt = isYouTube
      ? 'bestvideo[height<=480][vcodec^=avc1]+bestaudio[acodec^=mp4a]/bestvideo[height<=480]+bestaudio/best[height<=480]/worst'
      : 'bestvideo[height<=480]+bestaudio/best[height<=480]/worst';
  } else {
    fmt = isYouTube
      ? 'bestvideo[vcodec^=avc1]+bestaudio[acodec^=mp4a]/bestvideo+bestaudio/best'
      : 'bestvideo+bestaudio/best';
  }

  const job = {
    id: jobId,
    videoUrl,
    quality,
    status: 'starting',
    progress: '0%',
    detail: 'Đang chuẩn bị...',
    file: null,
    name: safeName,
    error: null,
    proc: null,
    createdAt: Date.now(),
  };

  jobs.set(jobId, job);

  // Phản hồi ngay jobId cho client để hiển thị tiến trình
  res.json({ success: true, jobId });

  console.log(`[⬇] Bắt đầu Job ${jobId} (${quality.toUpperCase()}): ${videoUrl}`);

  // MẶC ĐỊNH: Luôn luôn tải tốc độ tối đa (gỡ bỏ ép web_embedded, dùng client tự do)
  // Chỉ khi người dùng chủ động chọn phương án dự phòng (fallback=1) mới dùng web_embedded
  const useFallback = req.query.fallback === '1' || req.query.mode === 'embedded';

  // Khởi chạy download (có auto-retry & auto-resume tích hợp)
  runDownload({ job, jobId, tmpFile, fmt, isYouTube, isFacebook, videoUrl, useFallback, retryMode: false });
});

// ── 8. API KIỂM TRA TRẠNG THÁI ──────────────────────────────
app.get('/api/status', (req, res) => {
  const jobId = req.query.id;
  const job = jobs.get(jobId);
  if (!job) {
    return res.status(404).json({ error: 'Không tìm thấy tác vụ (job expired hoặc không tồn tại).' });
  }

  res.json({
    status: job.status,
    progress: job.progress,
    detail: job.detail || null,
    error: job.error,
    name: job.name,
    suggestFallback: !!job.suggestFallback,
  });
});

// ── 9. API HỦY TẢI ──────────────────────────────────────────
app.get('/api/cancel-download', (req, res) => {
  const jobId = req.query.id;
  const job = jobs.get(jobId);
  if (!job) {
    return res.json({ success: true, message: 'Job không tồn tại hoặc đã kết thúc.' });
  }

  console.log(`[✋] Người dùng yêu cầu hủy Job ${jobId}`);
  if (job.proc) {
    killProcessTree(job.proc);
    job.proc = null;
  }
  job.status = 'canceled';
  job.error = 'Đã hủy tải.';

  // Dọn dẹp file tạm dở dang
  setTimeout(() => {
    try {
      const base = `fbdown_${jobId}`;
      if (fs.existsSync(TMP_DIR)) {
        const stale = fs.readdirSync(TMP_DIR).filter(f => f.startsWith(base));
        for (const f of stale) {
          try { fs.unlinkSync(path.join(TMP_DIR, f)); } catch (_) {}
        }
      }
    } catch (_) {}
  }, 1000);

  res.json({ success: true, message: 'Đã hủy tải thành công.' });
});

// ── 10. API TẢI FILE VỀ MÁY (RES.DOWNLOAD AN TOÀN) ───────────
app.get('/api/get-file', (req, res) => {
  const jobId = req.query.id;
  const job = jobs.get(jobId);

  if (!job || job.status !== 'done' || !job.file) {
    return res.status(404).send('File chưa sẵn sàng hoặc đã hết hạn.');
  }

  if (!fs.existsSync(job.file)) {
    return res.status(404).send('File không còn tồn tại trên máy chủ.');
  }

  // Dùng res.download() chuẩn của Express
  // Tự động giải quyết mã hóa tên file UTF-8 (RFC 5987 / RFC 6266), Range requests và đóng luồng an toàn
  res.download(job.file, job.name, (err) => {
    if (err) {
      // Nếu client ngắt kết nối giữa chừng (res.headersSent)
      if (!res.headersSent) {
        res.status(500).send('Lỗi khi gửi file.');
      }
      console.warn(`[!] Client ngắt kết nối tải file (${jobId}):`, err.message);
    } else {
      console.log(`[💾] Đã truyền file thành công cho người dùng: ${job.name}`);
    }

    // Lên lịch xóa file sau 30 phút để cho phép người dùng bấm tải lại nếu muốn
    setTimeout(() => {
      if (job.file && fs.existsSync(job.file)) {
        try {
          fs.unlinkSync(job.file);
          console.log(`[🗑️] Đã giải phóng file tạm: ${job.file}`);
        } catch (_) {}
      }
      jobs.delete(jobId);
    }, 30 * 60 * 1000);
  });
});

// ── 11. KHỞI ĐỘNG SERVER ────────────────────────────────────
function startServer(portToUse) {
  const server = app.listen(portToUse, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║        🎬 FBDown Server v3.5 (Tối Ưu & Ổn Định)      ║');
    console.log(`║   → Địa chỉ truy cập: http://localhost:${portToUse}             ║`);
    console.log('║   → Chống sập toàn diện + Quản lý tiến trình an toàn ║');
    console.log('╚══════════════════════════════════════════════════════╝');
    console.log(`✅ yt-dlp.exe : ${fs.existsSync(YTDLP) ? YTDLP : 'CHƯA TÌM THẤY'}`);
    console.log(`✅ ffmpeg.exe : ${fs.existsSync(FFMPEG) ? FFMPEG : 'CHƯA TÌM THẤY'}`);
    console.log(`📁 Thư mục tạm : ${TMP_DIR}`);
    console.log('');
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[!] Cổng ${portToUse} đang bận, tự động chuyển sang cổng ${portToUse + 1}...`);
      startServer(portToUse + 1);
    } else {
      console.error('[!] Lỗi HTTP server:', err.message);
    }
  });
}

startServer(PORT);