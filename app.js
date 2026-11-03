/* ============================================
   FBDown – Frontend Logic (v3.5 – Tối ưu & Ổn định)
   app.js
   ============================================ */

// Tự động nhận diện host: localhost, 127.0.0.1, LAN IP hoặc domain
const API_BASE = (window.location.origin && window.location.origin.startsWith('http'))
  ? window.location.origin
  : 'http://localhost:3000';

// ── Particles (Tối ưu hóa GPU & tiết kiệm CPU) ─────────
(function initParticles() {
  const c = document.getElementById('bgParticles');
  if (!c) return;
  // Giảm bớt số hạt để web nhẹ nhàng, mượt mà hơn
  const count = window.innerWidth < 768 ? 12 : 20;
  for (let i = 0; i < count; i++) {
    const p = document.createElement('div');
    p.classList.add('particle');
    const s = Math.random() * 5 + 3;
    p.style.cssText = `width:${s}px;height:${s}px;left:${Math.random()*100}%;
      animation-duration:${Math.random()*18+14}s;animation-delay:-${Math.random()*15}s;
      opacity:${Math.random()*0.4+0.1};`;
    c.appendChild(p);
  }
})();

// ── DOM ELEMENTS ─────────────────────────────
const urlInput          = document.getElementById('urlInput');
const clearBtn          = document.getElementById('clearBtn');
const fetchBtn          = document.getElementById('fetchBtn');
const btnLoader         = document.getElementById('btnLoader');
const errorMsg          = document.getElementById('errorMsg');
const errorText         = document.getElementById('errorText');
const resultSec         = document.getElementById('resultSection');
const dlOptions         = document.getElementById('downloadOptions');
const thumbWrap         = document.getElementById('thumbnailWrapper');
const thumbImg          = document.getElementById('videoThumbnail');
const videoTitle        = document.getElementById('videoTitle');
const videoMeta         = document.getElementById('videoMeta');

// Progress Bar DOM
const progressBox       = document.getElementById('progressBox');
const progressStatusText = document.getElementById('progressStatusText');
const progressPctText   = document.getElementById('progressPctText');
const progressBarFill   = document.getElementById('progressBarFill');
const progressHint      = document.getElementById('progressHint');
const progressSpinner   = document.getElementById('progressSpinner');
const cancelDlBtn       = document.getElementById('cancelDlBtn');

// ── Quản lý tiến trình tải ────────────────────
let activeJobId = null;
let activePollTimer = null;
let _currentVideoUrl = '';

// ── Input events ─────────────────────────────
urlInput.addEventListener('input', () => {
  clearBtn.classList.toggle('visible', urlInput.value.length > 0);
  hideError();
});

urlInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') fetchVideo();
});

urlInput.addEventListener('focus', async () => {
  if (urlInput.value) return;
  try {
    const text = await navigator.clipboard.readText();
    if (isSupportedUrl(text)) {
      urlInput.value = text.trim();
      clearBtn.classList.add('visible');
    }
  } catch (_) {}
});

function clearInput() {
  urlInput.value = '';
  clearBtn.classList.remove('visible');
  hideError();
  urlInput.focus();
}

function hideError() {
  errorMsg.classList.remove('visible');
  errorText.innerHTML = '';
}

function showError(m) {
  errorText.textContent = m;
  errorMsg.classList.add('visible');
}

function showFallbackError(m, videoUrl, quality, filename) {
  errorText.innerHTML = `
    <div>${m}</div>
    <div style="margin-top:10px;">
      <button type="button" class="btn-fallback-error-retry" onclick="retryWithFallback('${encodeURIComponent(videoUrl)}', '${quality}', '${encodeURIComponent(filename)}')">
        👉 Bấm vào đây để tải ngay bằng Chế độ Dự phòng (Web Embedded)
      </button>
    </div>
  `;
  errorMsg.classList.add('visible');
}

window.retryWithFallback = function(encUrl, quality, encName) {
  hideError();
  startDownloadFlow(decodeURIComponent(encUrl), quality, decodeURIComponent(encName), 'Chế độ dự phòng', true);
};

function setLoading(v) {
  fetchBtn.classList.toggle('loading', v);
  fetchBtn.disabled = v;
  btnLoader.style.opacity = v ? '1' : '0';
  const textEl = fetchBtn.querySelector('.btn-text');
  if (textEl) textEl.style.opacity = v ? '0' : '1';
}

function isFacebookUrl(u) {
  try {
    const h = new URL(u.trim()).hostname;
    return h.endsWith('facebook.com') || h.endsWith('fb.watch') || h.endsWith('fb.com');
  } catch { return false; }
}

function isYouTubeUrl(u) {
  try {
    const h = new URL(u.trim()).hostname;
    return h.endsWith('youtube.com') || h === 'youtu.be' || h.endsWith('youtu.be');
  } catch { return false; }
}

function isSupportedUrl(u) {
  return isFacebookUrl(u) || isYouTubeUrl(u);
}

function getSourceName(u) {
  if (isYouTubeUrl(u)) return 'YouTube';
  return 'Facebook';
}

// ── Lấy thông tin video ──────────────────────
async function fetchVideo() {
  const raw = urlInput.value.trim();
  if (!raw) {
    showError('Vui lòng dán đường link video Facebook hoặc YouTube.');
    urlInput.focus();
    return;
  }
  if (!isSupportedUrl(raw)) {
    showError('Đường link không hợp lệ. Vui lòng nhập link chuẩn từ Facebook hoặc YouTube.');
    return;
  }

  // Dừng tải cũ nếu có
  stopActiveDownload();

  hideError();
  setLoading(true);
  resultSec.classList.remove('visible');
  hideProgress();

  try {
    const resp = await fetch(`${API_BASE}/api/get-video?url=${encodeURIComponent(raw)}`, {
      signal: AbortSignal.timeout(45000),
    });

    if (!resp.ok) {
      const errData = await resp.json().catch(() => ({}));
      throw new Error(errData.error || `Máy chủ phản hồi mã lỗi ${resp.status}`);
    }

    const data = await resp.json();
    if (!data.success) {
      throw new Error(data.error || 'Không tìm thấy video.');
    }

    renderResult(data);
  } catch (e) {
    if (e.name === 'TypeError' || (e.message && e.message.includes('fetch'))) {
      showError('❌ Không thể kết nối đến máy chủ! Hãy kiểm tra xem server.js đang chạy và thử lại.');
    } else {
      showError(e.message || 'Đã xảy ra lỗi khi lấy thông tin video.');
    }
  } finally {
    setLoading(false);
  }
}

// ── Hiển thị kết quả ─────────────────────────
function renderResult(data) {
  _currentVideoUrl = urlInput.value.trim();
  const srcName = getSourceName(_currentVideoUrl);
  const filePrefix = isYouTubeUrl(_currentVideoUrl) ? 'youtube' : 'facebook';

  if (data.thumbnail) {
    thumbImg.src = data.thumbnail;
    thumbImg.onerror = () => { thumbWrap.style.display = 'none'; };
    thumbWrap.style.display = 'block';
  } else {
    thumbWrap.style.display = 'none';
  }

  videoTitle.textContent = data.title || `${srcName} Video`;
  
  let metaInfo = `Nguồn: ${data.source || srcName}`;
  if (data.duration) metaInfo += ` · Thời lượng: ${data.duration}`;
  videoMeta.textContent = metaInfo;

  dlOptions.innerHTML = '';

  if (data.hd) {
    dlOptions.appendChild(createDownloadButton({
      fbUrl: _currentVideoUrl,
      quality: 'hd',
      label: data.hd.label || 'HD',
      desc: data.hd.size || 'Chất lượng cao nhất',
      isHD: true,
      name: `${filePrefix}_hd_${Date.now()}.mp4`
    }));
  }

  if (data.sd) {
    dlOptions.appendChild(createDownloadButton({
      fbUrl: _currentVideoUrl,
      quality: 'sd',
      label: data.sd.label || 'SD',
      desc: data.sd.size || 'Chất lượng thường',
      isHD: false,
      name: `${filePrefix}_sd_${Date.now()}.mp4`
    }));
  }

  if (!data.hd && !data.sd) {
    showError('Không tìm thấy luồng tải phù hợp cho video này.');
    return;
  }

  // Tùy chọn Chế độ Dự phòng (dành cho YouTube khi livestream vừa kết thúc hoặc gặp lỗi)
  if (isYouTubeUrl(_currentVideoUrl)) {
    const fallbackBox = document.createElement('div');
    fallbackBox.style.cssText = 'margin-top:14px;padding:12px;border-radius:10px;background:rgba(255,255,255,0.03);border:1px dashed rgba(255,255,255,0.15);text-align:center;';
    fallbackBox.innerHTML = `
      <div style="font-size:12px;color:rgba(255,255,255,0.65);margin-bottom:8px;">
        ⚠️ Video livestream vừa kết thúc hoặc gặp lỗi khi tải thường?
      </div>
      <button type="button" class="btn-fallback-mode" id="btnFallbackMode">
        🛡️ Tải bằng Chế độ Dự phòng (Web Embedded)
      </button>
    `;
    fallbackBox.querySelector('#btnFallbackMode').addEventListener('click', () => {
      startDownloadFlow(_currentVideoUrl, 'hd', `${filePrefix}_hd_fallback_${Date.now()}.mp4`, 'Chế độ dự phòng', true);
    });
    dlOptions.appendChild(fallbackBox);
  }

  resultSec.classList.add('visible');
  resultSec.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── Tạo nút tải xuống ────────────────────────
function createDownloadButton({ fbUrl, quality, label, desc, isHD, name }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `dl-btn ${isHD ? 'dl-btn-hd' : 'dl-btn-sd'}`;
  btn.innerHTML = `
    <div class="dl-btn-info">
      <div class="dl-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="16" height="16">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
      </div>
      <div>
        <div style="display:flex;align-items:center;gap:8px;">
          Tải về <span class="dl-btn-badge">${label}</span>
        </div>
        <div class="dl-btn-desc" id="desc-${quality}">${desc}</div>
      </div>
    </div>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
      <path d="M5 12h14M12 5l7 7-7 7"/>
    </svg>`;

  btn.addEventListener('click', () => {
    // Mặc định luôn ưu tiên tải tốc độ cao (fallback = false)
    startDownloadFlow(fbUrl, quality, name, desc, false);
  });

  return btn;
}

// ── Xử lý tiến trình tải thực sự ───────────────
async function startDownloadFlow(videoUrl, quality, filename, originalDesc, useFallback = false) {
  if (activeJobId) {
    showError('Một tác vụ tải đang chạy. Vui lòng đợi hoặc bấm "Hủy tải" trước.');
    return;
  }

  hideError();
  setButtonsDisabled(true);
  showProgress();

  progressStatusText.textContent = useFallback
    ? 'Đang tải với Chế độ Dự phòng (Web Embedded)...'
    : 'Đang khởi tạo kết nối tải tốc độ cao...';
  progressPctText.textContent = '0%';
  progressBarFill.style.width = '3%';
  progressHint.textContent = useFallback
    ? 'Đang chuẩn bị luồng dự phòng (khắc phục lỗi livestream kết thúc)...'
    : 'Đang chuẩn bị luồng tải tối đa băng thông mạng...';

  try {
    const startUrl = `${API_BASE}/api/start-download?url=${encodeURIComponent(videoUrl)}&q=${quality}&name=${encodeURIComponent(filename)}&fallback=${useFallback ? 1 : 0}`;
    const res = await fetch(startUrl);
    
    if (!res.ok) {
      const errJson = await res.json().catch(() => ({}));
      throw new Error(errJson.error || `Lỗi máy chủ (${res.status})`);
    }

    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Khởi tạo tải thất bại');

    activeJobId = data.jobId;

    // Bắt đầu vòng lặp thăm dò (polling) an toàn có giới hạn
    let errorCount = 0;
    const startTime = Date.now();
    const MAX_DURATION_MS = 180 * 60 * 1000; // 3 tiếng (180 phút) hỗ trợ video dài / livestream

    activePollTimer = setInterval(async () => {
      // Hết thời gian tối đa
      if (Date.now() - startTime > MAX_DURATION_MS) {
        stopPolling();
        showError('Quá trình tải vượt quá thời gian tối đa (3 giờ).');
        hideProgress();
        setButtonsDisabled(false);
        activeJobId = null;
        return;
      }

      try {
        const statusRes = await fetch(`${API_BASE}/api/status?id=${activeJobId}`);
        
        if (!statusRes.ok) {
          errorCount++;
          if (errorCount >= 4) {
            stopPolling();
            showError('Không tìm thấy trạng thái tải trên máy chủ.');
            hideProgress();
            setButtonsDisabled(false);
            activeJobId = null;
          }
          return;
        }

        // Reset error count khi nhận status thành công
        errorCount = 0;
        const statusData = await statusRes.json();

        if (statusData.status === 'downloading') {
          const pct = statusData.progress || '0%';
          const numPct = parseFloat(pct) || 0;
          progressStatusText.textContent = `Đang tải dữ liệu: ${pct}`;
          progressPctText.textContent = pct;
          progressBarFill.style.width = `${Math.min(numPct, 92)}%`;
          progressHint.textContent = statusData.detail || 'Đang tải các phân đoạn video tốc độ cao...';

        } else if (statusData.status === 'merging') {
          progressStatusText.textContent = 'Đang ghép video và âm thanh...';
          progressPctText.textContent = '95%';
          progressBarFill.style.width = '95%';
          progressHint.textContent = 'Sử dụng ffmpeg ghép chuẩn MP4 chất lượng cao...';

        } else if (statusData.status === 'done') {
          stopPolling();
          progressStatusText.textContent = '✅ Đã hoàn thành!';
          progressPctText.textContent = '100%';
          progressBarFill.style.width = '100%';
          progressHint.textContent = 'Đang lưu file vào máy tính của bạn...';
          if (progressSpinner) progressSpinner.style.display = 'none';

          // Tải file về máy
          tapDownload(`${API_BASE}/api/get-file?id=${activeJobId}`, filename);

          setTimeout(() => {
            hideProgress();
            setButtonsDisabled(false);
            activeJobId = null;
          }, 3500);

        } else if (statusData.status === 'canceled') {
          stopPolling();
          hideProgress();
          setButtonsDisabled(false);
          activeJobId = null;

        } else if (statusData.status === 'error') {
          stopPolling();
          if (statusData.suggestFallback || (statusData.error || '').includes('Chế độ Dự phòng') || (statusData.error || '').includes('livestream') || (statusData.error || '').includes('rỗng')) {
            showFallbackError(statusData.error || 'YouTube chặn tải ở tốc độ thường do video vừa kết thúc livestream.', videoUrl, quality, filename);
          } else {
            showError(`❌ Lỗi tải: ${statusData.error || 'yt-dlp gặp trục trặc.'}`);
          }
          hideProgress();
          setButtonsDisabled(false);
          activeJobId = null;
        }

      } catch (pollErr) {
        errorCount++;
        console.warn('Lỗi polling:', pollErr);
        if (errorCount >= 5) {
          stopPolling();
          showError('Mất kết nối với máy chủ khi đang theo dõi tiến trình tải.');
          hideProgress();
          setButtonsDisabled(false);
          activeJobId = null;
        }
      }
    }, 1500);

  } catch (err) {
    showError(err.message || 'Lỗi khi bắt đầu tải.');
    hideProgress();
    setButtonsDisabled(false);
    activeJobId = null;
  }
}

// ── Hủy tải đang chạy ────────────────────────
if (cancelDlBtn) {
  cancelDlBtn.addEventListener('click', stopActiveDownload);
}

async function stopActiveDownload() {
  if (!activeJobId) return;
  const jobIdToCancel = activeJobId;
  stopPolling();
  activeJobId = null;

  try {
    await fetch(`${API_BASE}/api/cancel-download?id=${jobIdToCancel}`);
  } catch (_) {}

  hideProgress();
  setButtonsDisabled(false);
  showError('Đã hủy quá trình tải.');
}

function stopPolling() {
  if (activePollTimer) {
    clearInterval(activePollTimer);
    activePollTimer = null;
  }
}

function showProgress() {
  if (progressBox) progressBox.style.display = 'block';
  if (progressSpinner) progressSpinner.style.display = 'inline-block';
}

function hideProgress() {
  if (progressBox) progressBox.style.display = 'none';
  if (progressBarFill) progressBarFill.style.width = '0%';
}

function setButtonsDisabled(disabled) {
  const btns = dlOptions.querySelectorAll('.dl-btn');
  btns.forEach(b => {
    b.disabled = disabled;
    b.style.opacity = disabled ? '0.5' : '1';
    b.style.pointerEvents = disabled ? 'none' : 'auto';
  });
}

function tapDownload(href, filename) {
  const a = Object.assign(document.createElement('a'), {
    href,
    download: filename,
    target: '_blank',
    rel: 'noopener noreferrer'
  });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => a.remove(), 600);
}

function resetForm() {
  stopActiveDownload();
  clearInput();
  resultSec.classList.remove('visible');
  dlOptions.innerHTML = '';
  thumbWrap.style.display = 'none';
  hideProgress();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ── Hiệu ứng cuộn trang (Scroll reveal) ───────
const obs = new IntersectionObserver(entries => {
  entries.forEach(e => {
    if (e.isIntersecting) {
      e.target.style.opacity = '1';
      e.target.style.transform = 'translateY(0)';
    }
  });
}, { threshold: 0.1 });

document.querySelectorAll('.step-card, .feature-item').forEach((el, i) => {
  el.style.cssText += `opacity:0;transform:translateY(24px);transition:opacity .4s ease ${i*.06}s,transform .4s ease ${i*.06}s;will-change:transform,opacity;`;
  obs.observe(el);
});
