/* ============================================
   FBDown – Frontend Logic (v3 – local server)
   app.js
   ============================================ */

const API_BASE = 'http://localhost:3000';

// ── Particles ────────────────────────────────
(function initParticles() {
  const c = document.getElementById('bgParticles');
  if (!c) return;
  for (let i = 0; i < 25; i++) {
    const p = document.createElement('div');
    p.classList.add('particle');
    const s = Math.random() * 6 + 3;
    p.style.cssText = `width:${s}px;height:${s}px;left:${Math.random()*100}%;
      animation-duration:${Math.random()*20+15}s;animation-delay:-${Math.random()*15}s;
      opacity:${Math.random()*0.5+0.1};`;
    c.appendChild(p);
  }
})();

// ── DOM ──────────────────────────────────────
const urlInput   = document.getElementById('urlInput');
const clearBtn   = document.getElementById('clearBtn');
const fetchBtn   = document.getElementById('fetchBtn');
const btnLoader  = document.getElementById('btnLoader');
const errorMsg   = document.getElementById('errorMsg');
const errorText  = document.getElementById('errorText');
const resultSec  = document.getElementById('resultSection');
const dlOptions  = document.getElementById('downloadOptions');
const thumbWrap  = document.getElementById('thumbnailWrapper');
const thumbImg   = document.getElementById('videoThumbnail');
const videoTitle = document.getElementById('videoTitle');
const videoMeta  = document.getElementById('videoMeta');

// ── Input events ─────────────────────────────
urlInput.addEventListener('input', () => {
  clearBtn.classList.toggle('visible', urlInput.value.length > 0);
  hideError();
});
urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') fetchVideo(); });
urlInput.addEventListener('focus', async () => {
  if (urlInput.value) return;
  try {
    const text = await navigator.clipboard.readText();
    if (isFacebookUrl(text)) { urlInput.value = text.trim(); clearBtn.classList.add('visible'); }
  } catch (_) {}
});

function clearInput()  { urlInput.value = ''; clearBtn.classList.remove('visible'); hideError(); urlInput.focus(); }
function hideError()   { errorMsg.classList.remove('visible'); }
function showError(m)  { errorText.textContent = m; errorMsg.classList.add('visible'); }

function setLoading(v) {
  fetchBtn.classList.toggle('loading', v);
  fetchBtn.disabled = v;
  btnLoader.style.opacity = v ? '1' : '0';
  fetchBtn.querySelector('.btn-text').style.opacity = v ? '0' : '1';
}

function isFacebookUrl(u) {
  try {
    const h = new URL(u.trim()).hostname;
    return h.endsWith('facebook.com') || h.endsWith('fb.watch') || h.endsWith('fb.com');
  } catch { return false; }
}

// ── Main Fetch ───────────────────────────────
async function fetchVideo() {
  const raw = urlInput.value.trim();
  if (!raw)               { showError('Vui lòng dán link video Facebook.'); urlInput.focus(); return; }
  if (!isFacebookUrl(raw)){ showError('Link không hợp lệ. Nhập đúng link từ Facebook.'); return; }

  hideError();
  setLoading(true);
  resultSec.classList.remove('visible');

  try {
    const resp = await fetch(`${API_BASE}/api/get-video?url=${encodeURIComponent(raw)}`, {
      signal: AbortSignal.timeout(30000),
    });
    const data = await resp.json();

    if (!data.success) {
      throw new Error(data.error || 'Không tìm thấy video.');
    }

    renderResult(data);
  } catch (e) {
    if (e.name === 'TypeError' || e.message.includes('fetch')) {
      showError('❌ Server chưa chạy! Hãy chạy lệnh: npm start  trong thư mục dự án rồi mở lại http://localhost:3000');
    } else {
      showError(e.message || 'Đã xảy ra lỗi. Thử lại.');
    }
  } finally {
    setLoading(false);
  }
}

// ── Render ────────────────────────────────────
let _currentFbUrl = ''; // lưu link FB gốc cho download

function renderResult(data) {
  // Lưu lại link FB gốc để dùng khi download qua /api/download
  _currentFbUrl = urlInput.value.trim();

  if (data.thumbnail) {
    thumbImg.src = data.thumbnail;
    thumbImg.onerror = () => { thumbWrap.style.display = 'none'; };
    thumbWrap.style.display = 'block';
  } else {
    thumbWrap.style.display = 'none';
  }

  videoTitle.textContent = data.title || 'Video đã sẵn sàng!';
  videoMeta.textContent  = `Nguồn: ${data.source || 'Facebook'} · Chọn chất lượng để tải về`;
  dlOptions.innerHTML    = '';

  // Truyền fbUrl + quality vào nút (không dùng CDN url)
  if (data.hd) dlOptions.appendChild(mkBtn({ fbUrl: _currentFbUrl, quality: 'hd', label: data.hd.label || 'HD', desc: data.hd.size || 'Chất lượng cao',    isHD: true,  name: 'facebook_hd.mp4' }));
  if (data.sd) dlOptions.appendChild(mkBtn({ fbUrl: _currentFbUrl, quality: 'sd', label: data.sd.label || 'SD', desc: data.sd.size || 'Chất lượng thường', isHD: false, name: 'facebook_sd.mp4' }));

  if (!data.hd && !data.sd) { showError('Không có link tải.'); return; }

  resultSec.classList.add('visible');
  resultSec.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function mkBtn({ fbUrl, quality, label, desc, isHD, name }) {
  const a = document.createElement('a');
  a.className = `dl-btn ${isHD ? 'dl-btn-hd' : 'dl-btn-sd'}`;
  a.innerHTML = `
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

  a.addEventListener('click', e => {
    e.preventDefault();
    // Gọi server: yt-dlp tải và stream về browser
    const dlUrl = `${API_BASE}/api/download?url=${encodeURIComponent(fbUrl)}&q=${quality}&name=${encodeURIComponent(name)}`;
    const descEl = document.getElementById(`desc-${quality}`);
    if (descEl) descEl.textContent = '⏳ Đang chuẩn bị tải... (có thể mất 5-15 giây)';
    tap(dlUrl, name);
    // Reset text sau 20s
    setTimeout(() => { if (descEl) descEl.textContent = desc; }, 20000);
  });
  return a;
}

function forceDownload() {} // không dùng nữa

function tap(href, filename) {
  const a = Object.assign(document.createElement('a'), { href, download: filename, target: '_blank', rel: 'noopener noreferrer' });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => a.remove(), 500);
}

function resetForm() {
  clearInput();
  resultSec.classList.remove('visible');
  dlOptions.innerHTML = '';
  thumbWrap.style.display = 'none';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ── Scroll reveal ─────────────────────────────
const obs = new IntersectionObserver(entries => {
  entries.forEach(e => { if (e.isIntersecting) { e.target.style.opacity='1'; e.target.style.transform='translateY(0)'; } });
}, { threshold: 0.1 });

document.querySelectorAll('.step-card, .feature-item').forEach((el, i) => {
  el.style.cssText += `opacity:0;transform:translateY(30px);transition:opacity .5s ease ${i*.08}s,transform .5s ease ${i*.08}s`;
  obs.observe(el);
});
