'use strict';

let runs = [];
let selectedId = null;
let selectedIter = null;
let activeTab = 'review';
let highlightQuery = null; // #C: 대장→개선본 연결 시 본문에서 강조할 인용구
let cmpVariant = null; // A/B 비교 뷰에서 하단 상세로 보고 있는 변형
let notifyEnabled = false;
const seenAlerts = new Set(); // runId:ts → 알림 1회만 발생

const $ = (sel) => document.querySelector(sel);

// ---------- inline SVG icon set (single stroke family, no emoji) ----------
const _S = (p, extra = '') =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra}>${p}</svg>`;
const ICONS = {
  star: _S('<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 17l-5.2 2.7 1-5.9L3.5 9.7l5.9-.8z"/>'),
  repeat: _S('<path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>'),
  award: _S('<circle cx="12" cy="8" r="5"/><path d="M8.2 12.5L7 22l5-3 5 3-1.2-9.5"/>'),
  coin: _S('<ellipse cx="12" cy="6" rx="8" ry="3.2"/><path d="M4 6v6c0 1.8 3.6 3.2 8 3.2s8-1.4 8-3.2V6"/><path d="M4 12v6c0 1.8 3.6 3.2 8 3.2s8-1.4 8-3.2v-6"/>'),
  cpu: _S('<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3"/>'),
  trend: _S('<path d="M3 17l6-6 4 4 7-7"/><path d="M17 7h4v4"/>'),
  bars: _S('<path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/>'),
  target: _S('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.4"/>'),
  ledger: _S('<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/>'),
  history: _S('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 8v4l3 2"/>'),
  doc: _S('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'),
  terminal: _S('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/>'),
  pause: _S('<path d="M9 5v14M15 5v14"/>'),
  play: _S('<path d="M6 4.5v15l13-7.5z" fill="currentColor" stroke="none"/>'),
  stop: _S('<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none"/>'),
  spinner: _S('<path d="M12 3a9 9 0 1 0 9 9"/>'),
  check: _S('<path d="M20 6L9 17l-5-5"/>'),
  warn: _S('<path d="M12 3l9 16H3z"/><path d="M12 10v4M12 17.5v.4"/>'),
  x: _S('<path d="M6 6l12 12M18 6L6 18"/>'),
  info: _S('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.4"/>'),
  alert: _S('<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>'),
  download: _S('<path d="M12 4v11M8 11l4 4 4-4"/><path d="M5 20h14"/>'),
  file: _S('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'),
  lock: _S('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
  signal: _S('<path d="M4 18a14 14 0 0 1 16 0M7 15a9 9 0 0 1 10 0M10 12a4.5 4.5 0 0 1 4 0"/><circle cx="12" cy="20" r="1.4" fill="currentColor" stroke="none"/>'),
  wand: _S('<path d="M5 3v4M3 5h4"/><path d="M18 14v4M16 16h4"/><path d="M13.5 6.5l4 4L8 20l-4-4z"/>'),
};
function icon(name, cls) { return `<span class="ic ${cls || ''}" aria-hidden="true">${ICONS[name] || ''}</span>`; }
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// ---------- responsive shell: drawer / scrim / scroll-condense ----------
function initShell() {
  const sidebar = $('#sidebar');
  const scrim = $('#scrim');
  const toggle = $('#nav-toggle');
  if (!sidebar || !scrim || !toggle) return;
  scrim.removeAttribute('hidden');
  const isMobile = () => window.matchMedia('(max-width: 1024px)').matches;

  function open() {
    sidebar.classList.add('open');
    scrim.classList.add('show');
    document.body.classList.add('nav-open');
    toggle.setAttribute('aria-expanded', 'true');
    const f = sidebar.querySelector('button, [href], input:not([type=hidden]), select, textarea');
    if (f) f.focus();
  }
  function close() {
    sidebar.classList.remove('open');
    scrim.classList.remove('show');
    document.body.classList.remove('nav-open');
    toggle.setAttribute('aria-expanded', 'false');
  }
  window.__closeDrawerIfMobile = () => { if (isMobile()) close(); };

  toggle.onclick = () => (sidebar.classList.contains('open') ? close() : open());
  scrim.onclick = close;
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sidebar.classList.contains('open')) { close(); toggle.focus(); }
  });
  // focus trap inside drawer (mobile only)
  sidebar.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || !isMobile() || !sidebar.classList.contains('open')) return;
    const f = sidebar.querySelectorAll('button, [href], input:not([type=hidden]), select, textarea, [tabindex]:not([tabindex="-1"])');
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  // header condense on scroll (detail pane scrolls internally)
  const header = document.querySelector('header');
  const detail = $('#detail');
  if (header && detail) detail.addEventListener('scroll', () => header.classList.toggle('scrolled', detail.scrollTop > 8), { passive: true });
  window.addEventListener('resize', debounce(() => { if (!isMobile()) close(); }, 150));
}

// ---------- 새 리뷰 폼 ----------
const FOCUS_PRESETS = [
  { label: '종합 (균형 평가)', value: '' },
  { label: '보안·취약점 중심', value: '보안 취약점, 입력 검증, 인증/인가, 민감정보 노출을 최우선으로 점검하고 개선하라.' },
  { label: '가독성·유지보수 중심', value: '가독성, 네이밍, 구조, 중복 제거, 유지보수성을 최우선으로 개선하라.' },
  { label: '성능 최적화 중심', value: '성능 병목, 불필요한 연산/할당, 비효율 알고리즘을 최우선으로 찾아 개선하라.' },
  { label: '문서 명료성·구조 중심', value: '문장 명료성, 논리 구조, 일관성, 완결성을 최우선으로 개선하라.' },
  { label: 'SEO·전환·마케팅 중심', value: 'SEO, 카피 설득력, 전환 유도, 접근성을 최우선으로 개선하라.' },
];

let reviewMethod = 'file';
// 입력이 URL 인가(파일 업로드 탭이 아니고, 종류가 url 이거나 URL/경로 탭).
function isUrlInput() {
  const kind = document.getElementById('kind-select') ? document.getElementById('kind-select').value : 'auto';
  return reviewMethod === 'url' || kind === 'url';
}
// URL 전용 옵션은 URL 입력일 때만, "평가 관점"은 비-URL(문서/코드)일 때만 노출(URL 은 리뷰범위로 대체).
function updateInputOptsVisibility() {
  const isUrl = isUrlInput();
  const urlBox = document.getElementById('url-opts');
  if (urlBox) urlBox.classList.toggle('hidden', !isUrl);
  const persp = document.getElementById('persp-wrap');
  if (persp) persp.classList.toggle('hidden', isUrl);
}

// 입력 종류·초점으로 추천 평가관점 키 산출(빈값=일반 문서 기본). #8 suggestRubric 의 클라이언트 미러.
function recommendPerspectiveKey() {
  const kind = document.getElementById('kind-select') ? document.getElementById('kind-select').value : 'auto';
  const fsel = document.getElementById('focus-select');
  const focus = fsel && FOCUS_PRESETS[+fsel.value] ? String(FOCUS_PRESETS[+fsel.value].value).toLowerCase() : '';
  if (kind === 'code') return '코드';
  if (/이력서|자기소개|자소서|resume|cv/.test(focus)) return '이력서';
  if (/마케팅|카피|광고|홍보|seo|market/.test(focus)) return '마케팅';
  return ''; // 일반 문서 → 내장 기본 루브릭(rubric off)
}

// "평가 관점" 선택을 실제 rubric 패널에 반영. URL 은 리뷰범위가 담당하므로 건드리지 않음.
function applyPerspective() {
  const sel = document.getElementById('persp-select');
  const on = document.getElementById('rubric-on');
  const box = document.getElementById('rubric-box');
  if (!sel || !on || !box) return;
  if (isUrlInput()) return; // URL 은 urlMode 로 채점 차원 전환
  let key = sel.value;
  if (key === 'custom') { on.checked = true; box.classList.remove('hidden'); return; }
  if (key === 'auto') key = recommendPerspectiveKey();
  if (!key) { on.checked = false; box.classList.add('hidden'); return; } // 일반 문서 → 내장 기본
  on.checked = true;
  box.classList.remove('hidden');
  const tsel = document.getElementById('rubric-template');
  if (tsel) tsel.value = key;
  loadRubricTemplate(key);
}
let selectedFile = null;

// ── 맞춤 평가 기준(rubric) 템플릿 + 편집기 ──
const RUBRIC_TEMPLATES = {
  문서: { passThreshold: 90, dims: [['명료성', 1, '문장이 명확하고 이해하기 쉬운가'], ['구조', 1, '논리 흐름과 구성이 탄탄한가'], ['완결성', 1, '빠진 내용 없이 충분한가'], ['정확성', 1.2, '사실·근거가 정확하고 일관적인가'], ['간결성', 0.8, '군더더기 없이 압축적인가']] },
  코드: { passThreshold: 90, dims: [['정확성', 1.4, '버그·엣지케이스 처리가 올바른가'], ['가독성', 1, '네이밍·구조·주석이 명확한가'], ['유지보수성', 1, '모듈화·중복제거·확장성'], ['보안', 1.2, '취약점·검증 누락이 없는가'], ['성능', 0.8, '불필요한 비용·비효율이 없는가']] },
  이력서: { passThreshold: 88, dims: [['임팩트', 1.3, '성과가 수치·결과 중심으로 설득력 있게 드러나는가'], ['명료성', 1, '문장이 간결하고 읽기 쉬운가'], ['직무적합성', 1.2, '대상 직무에 맞는 키워드·역량이 부각되는가'], ['일관성', 0.8, '시제·형식·표기가 일관적인가'], ['진정성', 0.7, '과장 없이 신뢰 가는가']] },
  마케팅: { passThreshold: 88, dims: [['설득력', 1.3, '행동을 유도하는 카피인가'], ['명료성', 1, '핵심 메시지가 분명한가'], ['타깃적합성', 1.1, '대상 독자에게 맞는 톤·근거인가'], ['SEO·접근성', 0.8, '검색·접근성 측면이 좋은가'], ['간결성', 0.8, '군더더기 없이 압축적인가']] },
};

function addRubricRow(name = '', weight = 1, desc = '') {
  const wrap = $('#rubric-dims');
  const row = document.createElement('div');
  row.className = 'rubric-dim-row';
  row.innerHTML = `<input class="rname" type="text" placeholder="항목명 (예: 명료성)" value="${escapeHtml(name)}" title="${escapeHtml(desc)}" data-desc="${escapeHtml(desc)}" />
    <input class="rweight" type="number" min="0.1" step="0.1" value="${weight}" />
    <button type="button" class="rdel" title="삭제">×</button>`;
  row.querySelector('.rdel').onclick = () => row.remove();
  wrap.appendChild(row);
}

function loadRubricTemplate(key) {
  const t = RUBRIC_TEMPLATES[key];
  $('#rubric-dims').innerHTML = '';
  if (!t) return;
  t.dims.forEach(([n, w, d]) => addRubricRow(n, w, d));
  $('#rubric-pass-input').value = t.passThreshold || '';
}

function initRubric() {
  const on = $('#rubric-on');
  const box = $('#rubric-box');
  if (!on || !box) return;
  on.onchange = () => {
    box.classList.toggle('hidden', !on.checked);
    if (on.checked && !$('#rubric-dims').children.length) loadRubricTemplate('문서');
  };
  $('#rubric-template').onchange = (e) => loadRubricTemplate(e.target.value);
  $('#rubric-add').onclick = () => addRubricRow();
  // 다각도 리뷰 토글 → 검증 옵션 노출
  const panelOn = $('#panel-on');
  if (panelOn) panelOn.onchange = () => $('#verify-wrap').classList.toggle('hidden', !panelOn.checked);
}

// 폼에서 rubric 객체를 만든다(미사용 시 null)
function buildRubric() {
  if (!$('#rubric-on') || !$('#rubric-on').checked) return null;
  const dims = [];
  document.querySelectorAll('#rubric-dims .rubric-dim-row').forEach((row) => {
    const name = row.querySelector('.rname').value.trim();
    if (!name) return;
    const weight = parseFloat(row.querySelector('.rweight').value) || 1;
    const description = row.querySelector('.rname').dataset.desc || undefined;
    dims.push({ name, weight, description });
  });
  if (!dims.length) return null;
  const pass = parseFloat($('#rubric-pass-input').value);
  return { dimensions: dims, passThreshold: Number.isFinite(pass) ? pass : undefined };
}

function initForm() {
  const fs = $('#focus-select');
  const optsHtml = FOCUS_PRESETS.map((p, i) => `<option value="${i}">${p.label}</option>`).join('');
  fs.innerHTML = optsHtml;
  // A/B 비교: 변형별 초점 셀렉트 채우기 + 토글
  if ($('#focusA')) $('#focusA').innerHTML = optsHtml;
  if ($('#focusB')) { $('#focusB').innerHTML = optsHtml; $('#focusB').value = '1'; }
  const cmpOn = $('#compare-on');
  if (cmpOn) cmpOn.onchange = () => $('#compare-box').classList.toggle('hidden', !cmpOn.checked);

  document.querySelectorAll('.seg-btn').forEach((b) => {
    b.onclick = () => {
      reviewMethod = b.dataset.method;
      document.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('active', x === b));
      $('#drop').classList.toggle('hidden', reviewMethod !== 'file');
      $('#url-input').classList.toggle('hidden', reviewMethod !== 'url');
      updateInputOptsVisibility();
      applyPerspective();
    };
  });
  // 종류·초점이 바뀌면 옵션 노출 갱신 + (자동 추천이면) 평가 관점 재반영
  if ($('#kind-select')) $('#kind-select').addEventListener('change', () => { updateInputOptsVisibility(); applyPerspective(); });
  if ($('#focus-select')) $('#focus-select').addEventListener('change', () => { const p = $('#persp-select'); if (p && p.value === 'auto') applyPerspective(); });
  if ($('#persp-select')) $('#persp-select').addEventListener('change', applyPerspective);
  // 사용자가 rubric 템플릿을 직접 고르면 "직접 설정"으로 표시(자동 반영과 충돌 방지)
  if ($('#rubric-template')) $('#rubric-template').addEventListener('change', () => { const p = $('#persp-select'); if (p) p.value = 'custom'; });
  updateInputOptsVisibility();
  applyPerspective();

  const drop = $('#drop');
  const fileInput = $('#file-input');
  drop.onclick = () => fileInput.click();
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  fileInput.onchange = () => setFile(fileInput.files[0]);
  ['dragover', 'dragenter'].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add('over');
    }),
  );
  ['dragleave', 'drop'].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.remove('over');
    }),
  );
  drop.addEventListener('drop', (e) => {
    if (e.dataTransfer.files && e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]);
  });

  $('#start-btn').onclick = submitReview;
  $('#notify-btn').onclick = enableNotifications;
  initRubric();
  initBackend();
}

// provider 선택 토글 + API 키 저장/상태
const KEY_PROVIDERS = ['anthropic', 'openai', 'gemini', 'together', 'nemotron'];
const KEY_PH = { anthropic: 'sk-ant-…', openai: 'sk-…', gemini: 'AIza…', together: '…', nemotron: 'nvapi-…' };
const PROVIDER_NAMES = { '': 'Claude Code 구독', anthropic: 'Anthropic API', openai: 'OpenAI', gemini: 'Google Gemini', together: 'Together AI', nemotron: 'NVIDIA Nemotron' };

function initBackend() {
  const overlay = $('#backend-overlay');
  const sel = $('#provider-select');
  if (!overlay || !sel) return;
  const open = () => { overlay.hidden = false; loadKeyStatus(); };
  const close = () => { overlay.hidden = true; };
  if ($('#backend-btn')) $('#backend-btn').onclick = open;
  if ($('#backend-close')) $('#backend-close').onclick = close;
  if ($('#backend-done')) $('#backend-done').onclick = close;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.hidden) close(); });

  // provider 라디오 → 숨은 select(기존 로직 호환)
  document.querySelectorAll('input[name="provider"]').forEach((r) => {
    r.onchange = () => { if (r.checked) { sel.value = r.value; applyBackendState(); } };
  });
  sel.addEventListener('change', applyBackendState);
  if ($('#model-select')) $('#model-select').addEventListener('change', updateBackendLabel);
  if ($('#provider-model')) $('#provider-model').addEventListener('input', updateBackendLabel);

  if ($('#keys-save')) $('#keys-save').onclick = saveKeys;
  if ($('#keys-clear-all')) $('#keys-clear-all').onclick = () => clearKey('all');
  document.querySelectorAll('.key-clear[data-clear]').forEach((b) => { b.onclick = () => clearKey(b.dataset.clear); });

  applyBackendState();
  loadKeyStatus();
}

// 숨은 provider-select 값을 기준으로 라디오·모델칸·버튼 라벨을 동기화.
function applyBackendState() {
  const sel = $('#provider-select');
  if (!sel) return;
  const api = !!sel.value;
  document.querySelectorAll('input[name="provider"]').forEach((r) => { r.checked = r.value === sel.value; });
  if ($('#cli-model-wrap')) $('#cli-model-wrap').classList.toggle('hidden', api);
  if ($('#provider-model-wrap')) $('#provider-model-wrap').classList.toggle('hidden', !api);
  updateBackendLabel();
}

function updateBackendLabel() {
  const btn = $('#backend-btn');
  const sel = $('#provider-select');
  if (!btn || !sel) return;
  const p = sel.value;
  let label = PROVIDER_NAMES[p] || PROVIDER_NAMES[''];
  if (!p) {
    const m = $('#model-select') ? $('#model-select').value : '';
    label += ' · ' + (m || '자동 모델');
  } else {
    const pm = $('#provider-model') ? $('#provider-model').value.trim() : '';
    label += pm ? ' · ' + pm : ' · 기본 모델';
  }
  btn.textContent = label + ' ▾';
}

async function loadKeyStatus() {
  try {
    const st = await fetchJson('/api/keys');
    for (const p of KEY_PROVIDERS) {
      const el = $('#key-' + p);
      if (el) el.placeholder = st[p] ? '저장됨 — 다시 입력하면 교체' : KEY_PH[p];
    }
  } catch {}
}

async function saveKeys() {
  const msg = $('#keys-msg');
  const body = {};
  for (const p of KEY_PROVIDERS) { const v = $('#key-' + p).value; if (v) body[p] = v; }
  if (!Object.keys(body).length) { msg.className = 'nr-msg err'; msg.textContent = '입력된 키가 없어요.'; return; }
  try {
    await fetch('/api/keys', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    for (const p of KEY_PROVIDERS) $('#key-' + p).value = '';
    await loadKeyStatus();
    msg.className = 'nr-msg ok'; msg.textContent = '✓ 저장됨 (이 PC에만)';
  } catch (e) {
    msg.className = 'nr-msg err'; msg.textContent = '저장 실패: ' + e.message;
  }
}

async function clearKey(provider) {
  const msg = $('#keys-msg');
  const label = provider === 'all' ? '전체' : (PROVIDER_NAMES[provider] || provider);
  if (!confirm(`${label} API 키를 초기화할까요?`)) return;
  try {
    await fetch('/api/keys?provider=' + encodeURIComponent(provider), { method: 'DELETE' });
    if (provider === 'all') { for (const p of KEY_PROVIDERS) $('#key-' + p).value = ''; }
    else if ($('#key-' + provider)) $('#key-' + provider).value = '';
    await loadKeyStatus();
    msg.className = 'nr-msg ok'; msg.textContent = '✓ 초기화됨';
  } catch (e) {
    msg.className = 'nr-msg err'; msg.textContent = '초기화 실패: ' + e.message;
  }
}

function setFile(f) {
  selectedFile = f || null;
  $('#file-name').innerHTML = f ? icon('file') + ' ' + escapeHtml(f.name) : '';
}

async function submitReview() {
  const btn = $('#start-btn');
  const msg = $('#nr-msg');
  msg.className = 'nr-msg';
  msg.textContent = '';

  const fd = new FormData();
  if (reviewMethod === 'file') {
    if (!selectedFile) return setMsg('err', '파일을 선택하세요.');
    fd.append('file', selectedFile);
  } else {
    const src = $('#url-input').value.trim();
    if (!src) return setMsg('err', 'URL 또는 경로를 입력하세요.');
    fd.append('source', src);
  }
  fd.append('focus', FOCUS_PRESETS[parseInt($('#focus-select').value, 10)].value);
  fd.append('kind', $('#kind-select').value);
  if ($('#urlmode-select')) fd.append('urlMode', $('#urlmode-select').value);
  if ($('#urlrender-select')) fd.append('urlRender', $('#urlrender-select').value);
  if ($('#urlcrawl-input') && $('#urlcrawl-input').value) fd.append('urlCrawl', $('#urlcrawl-input').value);
  if ($('#urlchecklinks-on') && $('#urlchecklinks-on').checked) fd.append('urlCheckLinks', 'true');
  if ($('#maxiter-input').value) fd.append('maxIter', $('#maxiter-input').value);
  if ($('#recur-input').value) fd.append('recurWindow', $('#recur-input').value);
  if ($('#maxcost-input').value) fd.append('maxCostPerIterUsd', $('#maxcost-input').value);
  if ($('#maxtotalcost-input').value) fd.append('maxTotalCostUsd', $('#maxtotalcost-input').value);
  if ($('#maxattempts-input').value) fd.append('maxAttemptsPerModel', $('#maxattempts-input').value);
  const provider = $('#provider-select') ? $('#provider-select').value : '';
  if (provider) {
    fd.append('provider', provider);
    const pm = $('#provider-model') ? $('#provider-model').value.trim() : '';
    if (pm) fd.append('providerModel', pm);
  } else if ($('#model-select').value) {
    fd.append('model', $('#model-select').value);
  }
  const rubric = buildRubric();
  if (rubric) fd.append('rubric', JSON.stringify(rubric));
  const refsInput = $('#refs-input');
  if (refsInput && refsInput.files) for (const rf of refsInput.files) fd.append('refs', rf);
  if ($('#panel-on') && $('#panel-on').checked) {
    fd.append('reviewMode', 'panel');
    if ($('#verify-on') && !$('#verify-on').checked) fd.append('verifyFindings', 'false');
  }
  if ($('#emit-on') && $('#emit-on').checked) fd.append('emitChanges', 'true');
  if ($('#autoresume-on') && $('#autoresume-on').checked) fd.append('autoResume', 'true');
  saveFormPrefs(); // #3: 마지막 설정 기억

  // A/B 비교 모드면 변형 설정을 붙이고 /api/compare 로
  let endpoint = '/api/runs';
  const compareMode = $('#compare-on') && $('#compare-on').checked;
  if (compareMode) {
    endpoint = '/api/compare';
    const fa = FOCUS_PRESETS[parseInt($('#focusA').value || '0', 10)] || FOCUS_PRESETS[0];
    const fb = FOCUS_PRESETS[parseInt($('#focusB').value || '0', 10)] || FOCUS_PRESETS[0];
    fd.append('focusA', fa.value); fd.append('labelA', fa.label);
    fd.append('focusB', fb.value); fd.append('labelB', fb.label);
    if ($('#modelA').value) fd.append('modelA', $('#modelA').value);
    if ($('#modelB').value) fd.append('modelB', $('#modelB').value);
  }

  btn.disabled = true;
  setMsg('ok', '시작 중…');
  try {
    const r = await fetch(endpoint, { method: 'POST', body: fd });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || '시작 실패');
    if (compareMode) {
      setMsg('ok', `✓ A/B 비교 시작됨: ${data.title}`);
      toast('ok', 'A/B 비교 시작', `${data.title} 를 두 설정으로 순차 분석합니다.`);
    } else {
      setMsg('ok', `✓ 리뷰 시작됨: ${data.title} (${data.kind})`);
      toast('ok', '리뷰 시작', `${data.title} 분석을 시작했습니다.`);
    }
    setFile(null);
    $('#file-input').value = '';
    $('#url-input').value = '';
    if ($('#refs-input')) $('#refs-input').value = '';
    setTimeout(loadRuns, 600);
  } catch (e) {
    setMsg('err', '✖ ' + e.message);
  } finally {
    btn.disabled = false;
  }
  function setMsg(cls, t) {
    msg.className = 'nr-msg ' + cls;
    msg.textContent = t;
  }
}

// #3: 고급 옵션을 localStorage 에 저장/복원(마지막 설정 기억). 스테일 값 혼란 방지.
const PREF_KEY = 'autodr.formprefs';
function saveFormPrefs() {
  try {
    const p = {};
    ['focus-select', 'kind-select', 'urlmode-select', 'urlrender-select', 'urlcrawl-input', 'maxiter-input', 'recur-input', 'maxcost-input', 'maxtotalcost-input', 'maxattempts-input', 'provider-select', 'model-select', 'persp-select'].forEach((id) => {
      const el = $('#' + id);
      if (el) p[id] = el.value;
    });
    ['panel-on', 'verify-on', 'emit-on', 'autoresume-on', 'urlchecklinks-on'].forEach((id) => {
      const el = $('#' + id);
      if (el) p[id] = el.checked;
    });
    localStorage.setItem(PREF_KEY, JSON.stringify(p));
  } catch {}
}
function restoreFormPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
    Object.entries(p).forEach(([id, v]) => {
      const el = $('#' + id);
      if (!el) return;
      if (typeof v === 'boolean') el.checked = v;
      else el.value = v;
      el.dispatchEvent(new Event('change')); // 의존 UI(검증·모델칸 표시 등) 갱신
    });
  } catch {}
}

// ---------- 런 제어 (일시정지 / 재개 / 중단) ----------
async function controlRun(id, action) {
  try {
    const r = await fetch(`/api/runs/${id}/${action}`, { method: 'POST' });
    if (!r.ok) throw new Error((await r.json()).error || '실패');
    const label = { pause: '일시정지', resume: '재개', stop: '중단' }[action];
    if (action === 'pause') toast('warn', '일시정지', '진행 중인 회차가 끝나면 멈춰요. (이후 토큰 미사용)');
    else if (action === 'resume') toast('ok', '재개됨', '다음 회차부터 다시 진행해요.');
    else toast('info', '바로 중단함', '진행 중인 호출을 즉시 종료했어요 — 추가 토큰이 나가지 않아요.');
    setTimeout(loadRuns, 400);
  } catch (e) {
    toast('err', '제어 실패', e.message);
  }
}

// 이어하기: 종료된 런의 베스트 + 열린 지적을 시드로 새 런을 시작.
async function continueRun(id) {
  try {
    const r = await fetch(`/api/runs/${id}/continue`, { method: 'POST' });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || '실패');
    toast('ok', '이어하기 시작', `베스트에서 이어서 다듬어요 (열린 지적 ${j.seeded}건 이어받음).`);
    setTimeout(loadRuns, 500);
  } catch (e) {
    toast('err', '이어하기 실패', e.message);
  }
}

// U7: 처음부터 다시 실행(원본 입력으로 새 런 시작 — 베스트 없어도 동작).
async function rerunRun(id) {
  try {
    const r = await fetch(`/api/runs/${id}/rerun`, { method: 'POST' });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || '실패');
    toast('ok', '다시 실행', '원본 입력으로 새 리뷰를 시작했어요.');
    setTimeout(loadRuns, 500);
  } catch (e) {
    toast('err', '다시 실행 실패', e.message);
  }
}

// U7: 실패 메시지를 사람 친화적으로 풀이(무엇이/왜).
function explainError(msg) {
  const m = String(msg || '');
  if (/504|gateway|게이트웨이/i.test(m))
    return { what: '서버가 일시적으로 응답하지 못했어요 (504).', why: 'NVIDIA 서버가 잠깐 붐볐을 때 생겨요. 보통 다시 실행하면 정상 처리됩니다.' };
  if (/JSON.*(추출|파싱).*실패|extract.*json/i.test(m))
    return { what: '모델 응답을 해석하지 못했어요.', why: '큰 문서를 한 번에 다루다 응답 형식이 잠깐 깨진 거예요. 다시 실행하면 대개 정상 처리됩니다.' };
  if (/잘렸|토큰 한도|truncat|length/i.test(m))
    return { what: '응답이 너무 길어 잘렸어요.', why: '입력이 매우 큰 경우예요. 입력을 나누거나 다시 시도해 보세요.' };
  if (/aborted|타임아웃|timeout|시간 초과/i.test(m))
    return { what: '응답이 너무 오래 걸려 중단됐어요.', why: '모델이 느릴 때 생겨요. 다시 실행하거나 더 빠른 설정(렌즈 경량 등)을 써보세요.' };
  if (/API 키|api key|키가 없/i.test(m))
    return { what: 'API 키 문제예요.', why: '설정에서 해당 provider 키가 등록돼 있는지 확인해 주세요.' };
  return { what: '예기치 못한 문제로 멈췄어요.', why: '아래 원본 메시지를 확인하거나 다시 실행해 보세요.' };
}

// ---------- 알림 ----------
async function enableNotifications() {
  if (!('Notification' in window)) return toast('err', '알림 미지원', '이 브라우저는 데스크톱 알림을 지원하지 않습니다.');
  const perm = await Notification.requestPermission();
  notifyEnabled = perm === 'granted';
  $('#notify-btn').classList.toggle('on', notifyEnabled);
  const lbl = $('#notify-btn .notify-label');
  if (lbl) lbl.textContent = notifyEnabled ? '알림 켜짐' : '알림 켜기';
  $('#notify-btn').title = notifyEnabled ? '자동 일시정지 시 데스크톱 알림을 받습니다' : '자동 일시정지 시 데스크톱 알림 받기';
  toast(notifyEnabled ? 'ok' : 'warn', notifyEnabled ? '알림 켜짐' : '알림 거부됨',
    notifyEnabled ? '자동 일시정지 시 데스크톱 알림을 받습니다.' : '브라우저 설정에서 허용해야 합니다.');
}

function desktopNotify(title, body) {
  if (notifyEnabled && 'Notification' in window && Notification.permission === 'granted') {
    try { new Notification(title, { body, icon: '' }); } catch {}
  }
}

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.type = 'sine'; o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.4);
    o.start(); o.stop(ctx.currentTime + 0.42);
  } catch {}
}

// 새로 발생한 자동 일시정지 알림 감지 → 토스트/데스크톱/비프
function checkAlerts() {
  for (const r of runs) {
    if (r.alert && r.status === 'paused') {
      const key = r.id + ':' + r.alert.ts;
      if (!seenAlerts.has(key)) {
        seenAlerts.add(key);
        toast('warn', r.alert.title, r.alert.message + `\n(런: ${r.title})`, 12000);
        desktopNotify('auto-dr · ' + r.alert.title, r.alert.message);
        beep();
      }
    }
  }
}

// ---------- 토스트 ----------
function toast(type, title, msg, ms = 6000) {
  const ico = icon({ ok: 'check', warn: 'warn', err: 'x', info: 'info' }[type] || 'info');
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.innerHTML = `<div class="t-ico">${ico}</div>
    <div class="t-body"><div class="t-title">${escapeHtml(title)}</div><div class="t-msg">${escapeHtml(msg)}</div></div>
    <div class="t-close">×</div>`;
  const close = () => { el.classList.add('out'); setTimeout(() => el.remove(), 250); };
  el.querySelector('.t-close').onclick = close;
  $('#toasts').appendChild(el);
  setTimeout(close, ms);
}

// ---------- 데이터 ----------
async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(r.status);
  return r.json();
}
// U5: 회차 산출물·원본은 한 번 쓰이면 불변이라 탭 전환 때마다 재fetch 하지 않고 캐시한다.
const _textCache = new Map();
const _isImmutable = (url) => /\/iterations\/\d+\/(review|artifact)\b/.test(url) || /\/input(\?|$)/.test(url);
async function fetchText(url) {
  if (_isImmutable(url) && _textCache.has(url)) return _textCache.get(url);
  const r = await fetch(url);
  if (!r.ok) return '';
  const t = await r.text();
  if (_isImmutable(url)) {
    if (_textCache.size > 60) _textCache.clear(); // 메모리 상한(런 전환 누적 방지)
    _textCache.set(url, t);
  }
  return t;
}

// changedIds: U1 — SSE 가 알려준 "이번에 바뀐 런 id" 목록. null 이면(최초 로드/알 수 없음) 전체 갱신.
async function loadRuns(changedIds) {
  try {
    runs = await fetchJson('/api/runs');
  } catch {
    runs = [];
  }
  checkAlerts();
  updateLiveChip();
  // 선택된 분석이 없으면 URL 해시(#run=id) 또는 가장 최근 분석을 자동 선택 — 열자마자 내용이 보이도록
  const hadSelection = !!selectedId;
  if (!selectedId && runs.length) {
    const fromHash = decodeURIComponent((location.hash.match(/run=([^&]+)/) || [])[1] || '');
    selectedId = fromHash && runs.some((r) => r.id === fromHash) ? fromHash : runs[0].id;
  }
  renderSidebar(); // 사이드바(목록)는 항상 가볍게 갱신
  if (!selectedId) return;
  // U1: 보고 있는 런이 이번 변경 대상이 아니면 상세는 다시 그리지 않는다(읽던 화면 보존 + 깜빡임 제거).
  const affectsSelected =
    changedIds == null || !hadSelection || changedIds.length === 0 || changedIds.includes(selectedId);
  if (affectsSelected) await renderDetail(selectedId);
}

// 탑바의 "분석 중 n건" 라이브 칩
function updateLiveChip() {
  const chip = $('#live-chip');
  if (!chip) return;
  const n = runs.filter((r) => r.status === 'running' || r.status === 'pending').length;
  const c = $('#live-count');
  if (c) c.textContent = n;
  chip.classList.toggle('show', n > 0);
}

const STATUS_LABEL = {
  pending: '대기',
  running: '진행중',
  paused: '일시정지',
  stopped_user: '사용자 중단',
  stopped_done: '완료(개선 종료)',
  stopped_plateau: '정체로 중단',
  stopped_declined: '하락으로 중단',
  stopped_cap: '반복 상한 도달',
  stopped_cost: '비용 상한 도달',
  stopped_ratelimit: '사용 한도 도달',
  completed: '완료',
  error: '오류',
};
function statusLabel(s) { return STATUS_LABEL[s] || s; }
function statusTag(s, big) {
  const spin = s === 'running' ? `<span class="spin">${icon('spinner')}</span> ` : s === 'paused' ? icon('pause') + ' ' : '';
  return `<span class="status-tag status-${s}${big ? ' big' : ''}">${spin}${statusLabel(s)}</span>`;
}
// 모델 id 를 보기 좋게 (claude-opus-4-8-... → Opus 4.8)
function prettyModel(m) {
  if (!m) return null;
  return m
    .split(',')
    .map((one) => {
      const s = one.trim().replace(/^claude-/, '');
      const fam = (s.match(/(opus|sonnet|haiku|fable)/i) || [])[1];
      const ver = (s.match(/(\d+)-(\d+)/) || []);
      const label = fam ? fam[0].toUpperCase() + fam.slice(1).toLowerCase() : s;
      return ver[1] ? `${label} ${ver[1]}.${ver[2]}` : label;
    })
    .join(', ');
}
function reqModelLabel(run) {
  const m = run.config && run.config.model;
  if (!m || m === 'auto') return '자동 (라우팅)';
  return m;
}
function scoreColor(v) {
  if (v == null) return 'var(--faint)';
  if (v >= 85) return 'var(--ok)';
  if (v >= 65) return 'var(--brand)';
  if (v >= 45) return 'var(--warn)';
  return 'var(--bad)';
}
// 베스트가 "잠긴"(수렴/완료) 상태인지
function isLocked(run) {
  return run.bestScore != null && (run.status === 'completed' || run.status === 'stopped_done');
}
// 포착 패널 하단 텔레메트리 스트립
function telemetryStrip(run) {
  const cap = run.config && run.config.maxIterations;
  const pass = `${run.currentIteration}${cap ? ` / ${cap}` : ''}`;
  const model = prettyModel(run.actualModel) || reqModelLabel(run);
  const cost = run.totalCostUsd ? `$${run.totalCostUsd.toFixed(4)}` : '$0';
  const costCap = run.config && run.config.maxTotalCostUsd ? ` / cap $${run.config.maxTotalCostUsd}` : '';
  const its = run.iterations || [];
  const avg = its.length ? (its.reduce((s, i) => s + (i.durationMs || 0), 0) / its.length / 1000).toFixed(1) + 's' : '—';
  const item = (l, v, cls = '') => `<span class="tele-item"><span class="tl">${l}</span><span class="tv ${cls}">${v}</span></span>`;
  return (
    item('PASS', pass) +
    item('MODEL', escapeHtml(model), 'signal') +
    item('COST', cost + costCap, costCap ? 'warn' : '') +
    item('AVG', avg)
  );
}
// 토큰 수 축약(12,345 → 12.3K)
function fmtTok(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(Math.round(n));
}
function tokTotal(t) {
  return t ? t.input + t.output + t.cacheRead + t.cacheWrite : 0;
}
// 런 누적 토큰 사용 카드
function tokenCardHtml(run) {
  const t = run.totalTokens;
  if (!t) return '';
  const total = tokTotal(t);
  const cell = (label, val, hint, cls = '') =>
    `<div class="tok-cell ${cls}"><span class="tok-label">${label}</span><span class="tok-val">${fmtTok(val)}</span>${hint ? `<span class="tok-hint">${hint}</span>` : ''}</div>`;
  return `<details class="card collapsible">
    <summary>${icon('coin')} 토큰 사용 <span class="right">${run.totalCostUsd ? `$${run.totalCostUsd.toFixed(4)}` : '$0'}</span></summary>
    <div class="tok-grid">
      ${cell('입력', t.input, '1× 단가')}
      ${cell('출력', t.output, '5× 단가')}
      ${cell('캐시 읽기', t.cacheRead, '0.1×')}
      ${cell('캐시 쓰기', t.cacheWrite, '1.25×')}
      ${cell('합계', total, '', 'total')}
    </div>
    <div class="tok-note">회차마다 Claude Code 에이전트 기본 컨텍스트(캐시 ~23K 토큰)가 매번 실려요. 회차·다각도(panel)·A/B가 늘수록 토큰이 곱으로 증가합니다.</div>
  </details>`;
}
// #4: 비용 게이지 — 누적 비용 vs 상한(임계선). 멈춘 이유를 한눈에.
function costGaugeHtml(run) {
  const cap = run.config && run.config.maxTotalCostUsd;
  const spent = run.totalCostUsd || 0;
  if (!cap || cap <= 0) {
    return `<div class="cost-gauge"><div class="cg-head"><span class="cg-label">${icon('coin')} 비용</span><span><strong>$${spent.toFixed(4)}</strong> · 상한 없음</span></div></div>`;
  }
  const pct = Math.min(100, Math.round((spent / cap) * 100));
  const lvl = pct >= 90 ? 'crit' : pct >= 75 ? 'warn' : '';
  return `<div class="cost-gauge ${lvl}">
    <div class="cg-head"><span class="cg-label">${icon('coin')} 비용</span><span>$${spent.toFixed(4)} / $${cap} (${pct}%)</span></div>
    <div class="cg-bar"><div class="cg-fill" style="width:${pct}%"></div></div>
  </div>`;
}

// U3: 회차별 단계 간트. 각 회차를 리뷰→검증→개선→채점 누적 막대로(폭=소요시간 비례).
const STAGE_COLORS = { '리뷰': '#5B8DEF', '검증': '#E8A13A', '개선': 'var(--brand)', '채점': '#16A97C' };
function fmtSec(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + '초';
  return Math.floor(s / 60) + '분 ' + (s % 60) + '초';
}
function stageGanttHtml(run) {
  const its = (run.iterations || []).filter((i) => i.stages && i.stages.length);
  if (!its.length) return '';
  // 가장 긴 회차 총합을 기준으로 막대 전체 폭을 맞춰(회차 간 길이 비교 가능).
  const totals = its.map((i) => i.stages.reduce((s, st) => s + (st.ms || 0), 0));
  const maxTotal = Math.max(...totals, 1);
  const names = [...new Set(its.flatMap((i) => i.stages.map((s) => s.name)))];
  const legend = names
    .map((n) => `<span class="gantt-leg"><i style="background:${STAGE_COLORS[n] || '#999'}"></i>${n}</span>`)
    .join('');
  const rows = its
    .map((it, idx) => {
      const total = totals[idx];
      const segs = it.stages
        .map((st) => {
          const pctOfBar = (st.ms / total) * 100;
          return `<span class="gantt-seg" style="width:${pctOfBar}%;background:${STAGE_COLORS[st.name] || '#999'}" title="${st.name} · ${fmtSec(st.ms)}">${pctOfBar > 14 ? st.name : ''}</span>`;
        })
        .join('');
      const barW = (total / maxTotal) * 100;
      return `<div class="gantt-row">
        <span class="gantt-lbl">${it.iteration}번째</span>
        <span class="gantt-track"><span class="gantt-bar" style="width:${barW}%">${segs}</span></span>
        <span class="gantt-total">${fmtSec(total)}</span>
      </div>`;
    })
    .join('');
  return `<div class="card">
    <h2>${icon('bars')} 단계별 소요 <span class="right gantt-legend">${legend}</span></h2>
    <div class="gantt">${rows}</div>
  </div>`;
}

// #B: 인터랙티브 점수 추이 차트(SVG). 점=회차(채택 채움/폐기 링/베스트 강조), 호버 툴팁.
function scoreChartHtml(run) {
  const its = run.iterations || [];
  if (!its.length) return '';
  const W = 600, H = 168, padL = 30, padR = 16, padT = 16, padB = 26;
  const n = its.length;
  const x = (i) => (n === 1 ? padL + (W - padL - padR) / 2 : padL + (i / (n - 1)) * (W - padL - padR));
  const y = (v) => padT + (1 - v / 100) * (H - padT - padB);
  const grid = [0, 50, 100]
    .map((v) => `<line class="sc-grid" x1="${padL}" y1="${y(v).toFixed(1)}" x2="${W - padR}" y2="${y(v).toFixed(1)}"/><text class="sc-axis" x="${padL - 6}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end">${v}</text>`)
    .join('');
  const pass = run.config && run.config.rubric && run.config.rubric.passThreshold;
  const passLine = pass != null ? `<line class="sc-pass" x1="${padL}" y1="${y(pass).toFixed(1)}" x2="${W - padR}" y2="${y(pass).toFixed(1)}"/><text class="sc-passlbl" x="${W - padR}" y="${(y(pass) - 4).toFixed(1)}" text-anchor="end">합격 ${pass}</text>` : '';
  const linePts = its.map((it, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(it.score).toFixed(1)}`).join(' ');
  const line = n > 1 ? `<path class="sc-line" d="${linePts}" />` : '';
  const dots = its
    .map((it, i) => {
      const best = it.iteration === run.bestIteration;
      const cls = best ? 'pt-best' : it.kept ? 'pt-kept' : 'pt-drop';
      const tip = `#${it.iteration} · ${it.score}점 · ${best ? '베스트' : it.kept ? '채택' : '폐기'}${it.model ? ' · ' + prettyModel(it.model) : ''}`;
      return `<circle class="sc-pt ${cls}" cx="${x(i).toFixed(1)}" cy="${y(it.score).toFixed(1)}" r="${best ? 5.5 : 4}" data-tip="${escapeHtml(tip)}"/><text class="sc-val" x="${x(i).toFixed(1)}" y="${(y(it.score) - 9).toFixed(1)}" text-anchor="middle">${it.score}</text>`;
    })
    .join('');
  const xlabels = its.map((it, i) => `<text class="sc-axis" x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${it.iteration}</text>`).join('');
  return `<div class="scorechart"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="회차별 점수 추이">
    ${grid}${passLine}${line}${dots}${xlabels}
  </svg><div class="sc-tip" hidden></div></div>`;
}
// 차트 점 호버 → 툴팁
function attachChartHover(root) {
  const wrap = (root || document).querySelector('.scorechart');
  if (!wrap) return;
  const tip = wrap.querySelector('.sc-tip');
  wrap.querySelectorAll('.sc-pt').forEach((pt) => {
    pt.addEventListener('mouseenter', () => {
      tip.textContent = pt.dataset.tip;
      tip.hidden = false;
      const wr = wrap.getBoundingClientRect();
      const pr = pt.getBoundingClientRect();
      tip.style.left = Math.round(pr.left - wr.left + pr.width / 2) + 'px';
      tip.style.top = Math.round(pr.top - wr.top - 8) + 'px';
    });
    pt.addEventListener('mouseleave', () => { tip.hidden = true; });
  });
}

// 초안 스텝퍼 — 각 패스를 노드로(채택=민트, 베스트=보라)
function stepperHtml(run) {
  const its = run.iterations || [];
  if (!its.length) return '';
  const nodes = its.map((it) => {
    const cls = it.iteration === run.bestIteration ? 'best' : it.kept ? 'kept' : '';
    return `<div class="step ${cls}"><div class="node">${it.iteration}</div><div class="lbl">${it.score}점</div></div>`;
  });
  return `<div class="stepper">${nodes.join('<div class="step-link"></div>')}</div>`;
}

let runQuery = ''; // #14: 사이드바 검색어
function renderSidebar() {
  const ul = $('#run-list');
  ul.innerHTML = '';
  // #14: 제목·상태로 필터
  const shown = runQuery
    ? runs.filter((r) => (r.title || '').toLowerCase().includes(runQuery) || statusLabel(r.status).toLowerCase().includes(runQuery))
    : runs;
  $('#run-count').textContent = runQuery ? `${shown.length}/${runs.length}` : runs.length;
  for (const r of shown) {
    const li = document.createElement('li');
    if (r.id === selectedId) li.classList.add('active');
    const live = r.status === 'running' || r.status === 'pending';
    const pct = r.bestScore != null ? r.bestScore : 0;
    const sub = live
      ? `분석 중 · ${(r.currentIteration || 0) + 1}번째 다듬는 중`
      : `${statusLabel(r.status)} · ${r.bestScore != null ? `${r.bestScore}점` : '—'}`;
    li.innerHTML = `
      <div class="an-ring ${live ? 'live' : ''}" style="--p:${pct}" aria-hidden="true"><span class="rp">${live ? '' : (r.bestScore ?? '—')}</span></div>
      <div class="an-body">
        <div class="an-title">${r.compare ? `<span class="vbadge">${r.compare.variant}</span> ` : ''}${escapeHtml(r.title)}</div>
        <div class="an-sub ${live ? 'live' : ''}">${escapeHtml(sub)}</div>
      </div>
      <button class="an-del" title="이 분석 삭제" aria-label="삭제">×</button>`;
    li.onclick = () => {
      selectedId = r.id;
      selectedIter = null;
      try { history.replaceState(null, '', '#run=' + encodeURIComponent(r.id)); } catch {}
      renderSidebar();
      renderDetail(r.id);
      if (window.__closeDrawerIfMobile) window.__closeDrawerIfMobile();
    };
    const del = li.querySelector('.an-del');
    if (del) del.onclick = (ev) => { ev.stopPropagation(); deleteRun(r.id, r.title); };
    ul.appendChild(li);
  }
}

// #14: 런 삭제(확인 후). 진행 중이면 막는다.
async function deleteRun(id, title) {
  const run = runs.find((r) => r.id === id);
  if (run && (run.status === 'running' || run.status === 'pending')) {
    toast('warn', '삭제 불가', '진행 중인 분석은 먼저 중단하세요.');
    return;
  }
  if (!confirm(`"${title}" 분석 기록을 삭제할까요? (산출물 폴더가 지워집니다)`)) return;
  try {
    const r = await fetch('/api/runs/' + id, { method: 'DELETE' });
    if (!r.ok) throw new Error((await r.json()).error || '실패');
    if (selectedId === id) { selectedId = null; $('#detail').innerHTML = ''; }
    toast('ok', '삭제됨', '분석 기록을 지웠어요.');
    loadRuns();
  } catch (e) {
    toast('err', '삭제 실패', e.message);
  }
}

let _renderedDetailId = null; // U1: 같은 런을 다시 그릴 때만 스크롤 위치를 보존
async function renderDetail(id) {
  const detailEl = $('#detail');
  const samePane = _renderedDetailId === id;
  const prevScroll = samePane && detailEl ? detailEl.scrollTop : 0;
  let run;
  try {
    run = await fetchJson('/api/runs/' + id);
  } catch {
    detailEl.innerHTML = '<div class="empty">런을 불러올 수 없습니다.</div>';
    _renderedDetailId = null;
    return;
  }
  if (run.compare) { renderCompare(run); _renderedDetailId = id; return; }
  await renderNormalDetail(run, '#detail');
  _renderedDetailId = id;
  // 같은 런의 라이브 갱신이면 읽던 스크롤 위치를 복원(매 SSE 틱마다 맨 위로 튀는 것 방지).
  if (samePane && detailEl) detailEl.scrollTop = prevScroll;
}

// ── 라이브 진행 표시(경과 시간·회차 ETA·단계) ──
let _liveTicker = null;
const _roundStarts = {}; // { runId: { iter, ts } } — 회차 시작 시각(클라이언트 추정)

// 회차당 평균 소요(ms). 완료된 회차가 있으면 실측 평균, 없으면 provider 로 추정.
function avgIterMs(run) {
  const its = (run.iterations || []).filter((i) => i.durationMs);
  if (its.length) return its.reduce((s, i) => s + i.durationMs, 0) / its.length;
  return run.config && run.config.provider === 'nemotron' ? 6 * 60_000 : 60_000;
}

// 최근 로그로 현재 단계 추정: 0 리뷰 · 1 개선 · 2 채점
function detectStage(run) {
  const last = (run.log || []).filter((l) => l.level !== 'error').slice(-1)[0];
  const m = last ? last.msg : '';
  if (/채점/.test(m)) return 2;
  if (/리뷰|탐색|검토|검증|찾는|지적/.test(m)) return 0;
  if (/다듬|개선|적용|마무리|edit/i.test(m)) return 1;
  return 0;
}

// ms → "1:23" (분:초)
function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}
// ms → "약 6분" / "약 45초" (대략)
function fmtAbout(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}초`;
  const m = Math.round(s / 60);
  return `${m}분`;
}

function stopLiveTicker() {
  if (_liveTicker) { clearInterval(_liveTicker); _liveTicker = null; }
}

// 1초마다 경과/ETA/회차 진행바를 갱신(서버 이벤트 없이도 살아 움직이게).
function setupLiveTicker(run, avg) {
  stopLiveTicker();
  const rs = _roundStarts[run.id];
  if (!rs || rs.iter !== run.currentIteration) {
    _roundStarts[run.id] = { iter: run.currentIteration, ts: Date.now() };
  }
  const createdMs = new Date(run.createdAt).getTime();
  const tick = () => {
    const elapsedEl = document.getElementById('live-elapsed');
    if (!elapsedEl) return stopLiveTicker(); // 화면을 벗어남
    const now = Date.now();
    elapsedEl.textContent = fmtClock(now - createdMs);
    const roundElapsed = now - _roundStarts[run.id].ts;
    const remain = avg - roundElapsed;
    const etaEl = document.getElementById('live-eta');
    if (etaEl) etaEl.textContent = remain > 4000 ? `이번 회차 약 ${fmtAbout(remain)} 남음` : '이번 회차 곧 마무리…';
    const pb = document.getElementById('round-prog');
    if (pb) pb.style.width = `${Math.min(100, (roundElapsed / avg) * 100).toFixed(1)}%`;
  };
  tick();
  _liveTicker = setInterval(tick, 1000);
}

// 일반(단일 런) 상세 본문 — 비교 뷰에서는 하위 컨테이너(mountSel)에 변형별로 렌더한다.
async function renderNormalDetail(run, mountSel) {
  const id = run.id; // 템플릿의 다운로드/링크 URL 에서 사용
  const best = run.bestIteration != null ? run.iterations.find((i) => i.iteration === run.bestIteration) : null;
  if (selectedIter == null) selectedIter = run.bestIteration ?? run.currentIteration ?? null;

  const canPause = run.status === 'running';
  const canResume = run.status === 'paused';
  const canStop = run.status === 'running' || run.status === 'paused' || run.status === 'pending';

  const firstScore = run.scores && run.scores.length ? run.scores[0].score : null;
  const delta = run.bestScore != null && firstScore != null ? run.bestScore - firstScore : null;
  const working = run.status === 'running' || run.status === 'pending';
  const paused = run.status === 'paused';
  const model = prettyModel(run.actualModel) || (run.config && run.config.model && run.config.model !== 'auto' ? run.config.model : '자동');
  const nextPass = (run.currentIteration || 0) + 1;

  const controls =
    (canPause ? `<button class="ctl-btn pause" data-act="pause">${icon('pause')} 일시정지</button>` : '') +
    (canResume ? `<button class="ctl-btn resume" data-act="resume">${icon('play')} 재개</button>` : '') +
    (canStop ? `<button class="ctl-btn stop" data-act="stop" title="진행 중인 호출을 즉시 종료해 토큰 낭비를 막아요">${icon('stop')} 바로 그만두기</button>` : '') +
    (!working && !paused && run.bestIteration != null ? `<button class="ctl-btn resume" data-continue="1" title="베스트 결과에서 이어서 더 다듬어요 (열린 지적을 이어받음)">${icon('play')} 이어하기</button>` : '') +
    (!working && !paused && run.input.origFormat ? `<a class="ctl-btn" href="/api/runs/${id}/best/office">${icon('download')} ${run.officeInPlace ? '원본 양식' : ''}.${run.input.origFormat} 받기</a>` : '');

  // #11: 현재 단계 = 가장 최근 로그(에러 제외). panel 길이로 인한 "멈춘 줄" 오해 감소.
  const lastStep = (run.log || []).filter((l) => l.level !== 'error').slice(-1)[0];
  const stageIdx = detectStage(run); // 0 리뷰 · 1 개선 · 2 채점
  const avgMs = avgIterMs(run);
  let hero;
  if (working) {
    const stage = (i, label) =>
      `<div class="stage ${stageIdx > i ? 'done' : ''} ${stageIdx === i ? 'active' : ''}"><span class="stage-dot"></span>${label}</div>`;
    hero = `
      <section class="hero working">
        <div class="hero-controls">${controls}</div>
        <div class="orb" aria-hidden="true"><div class="orb-core"><b>${nextPass}</b><small>번째</small></div></div>
        <div class="hero-main">
          <div class="hero-line1">분석 중 <span class="dots" aria-hidden="true"><i></i><i></i><i></i></span></div>
          <div class="hero-line2">지금 ${nextPass}번째 초안을 다듬고 있어요${run.currentIteration > 0 ? ` · 지금까지 ${run.currentIteration}번 다듬음` : ''}</div>
          <div class="hero-line3">
            <span class="model-pill">${icon('wand')} ${escapeHtml(model)}</span>
            ${run.bestScore != null ? `<span>지금 가장 좋은 점수 <strong>${run.bestScore}</strong>점</span>` : '<span class="muted">첫 점수를 매기는 중…</span>'}
          </div>
          <div class="stage-track">${stage(0, '리뷰')}<span class="stage-arr"></span>${stage(1, '개선')}<span class="stage-arr"></span>${stage(2, '채점')}</div>
          <div class="round-bar" aria-hidden="true"><i id="round-prog"></i></div>
          <div class="live-timer">
            <span class="lt-item">⏱ 경과 <b id="live-elapsed">0:00</b></span>
            <span class="lt-sep">·</span>
            <span class="lt-item" id="live-eta">예상 계산 중…</span>
            <span class="lt-sep">·</span>
            <span class="lt-item muted">회차당 평균 ${fmtAbout(avgMs)}</span>
          </div>
          <div class="live-stream-wrap">
            <div class="live-stream-head">✍️ 실시간 생성 <span class="ls-cursor" aria-hidden="true"></span></div>
            <pre class="live-stream" id="live-stream"><span class="muted">모델 응답을 기다리는 중…</span></pre>
          </div>
          ${lastStep ? `<div class="hero-step">▸ ${escapeHtml(lastStep.msg)}</div>` : ''}
        </div>
      </section>`;
  } else if (paused) {
    hero = `
      <section class="hero">
        <div class="hero-controls">${controls}</div>
        <div class="ring" style="--p:${run.bestScore ?? 0}" aria-hidden="true"><div class="ring-core">${run.bestScore ?? '—'}</div></div>
        <div class="hero-main">
          <div class="hero-line1">${icon('pause')} 잠시 멈췄어요</div>
          <div class="hero-line2">재개하면 멈춘 곳부터 이어서 다듬어요.</div>
          <div class="hero-line3">지금까지 ${run.currentIteration}번 다듬음</div>
          ${stepperHtml(run)}
        </div>
      </section>`;
  } else {
    const isError = run.status === 'error';
    const fullClean = run.status === 'completed' || run.status === 'stopped_done';
    const headline = isError
      ? '문제가 생겨서 멈췄어요'
      : fullClean
        ? '문서를 다 다듬었어요'
        : run.bestIteration != null
          ? `가장 좋았던 건 ${run.bestIteration}번째 초안이에요`
          : '아직 다듬은 결과가 없어요';
    const errInfo = isError ? explainError(run.message) : null;
    const sub = isError
      ? '아래에서 원인을 확인하고 다시 시도할 수 있어요.'
      : delta != null && delta > 0
        ? `<span class="is-ok">+${delta}점 좋아졌어요</span> · 총 ${run.currentIteration}번 다듬음`
        : `총 ${run.currentIteration}번 다듬음`;
    hero = `
      <section class="hero done ${isError ? 'is-error' : ''}">
        <div class="hero-controls">${controls}</div>
        <div class="ring" style="--p:${run.bestScore ?? 0}" aria-hidden="true"><div class="ring-core">${run.bestScore ?? '—'}</div></div>
        <div class="hero-main">
          <div class="hero-line1">${headline}</div>
          <div class="hero-line2">${sub}</div>
          ${isError ? `<div class="err-card">
            <div class="err-what">⚠️ ${escapeHtml(errInfo.what)}</div>
            <div class="err-why">${escapeHtml(errInfo.why)}</div>
            <div class="err-actions">
              <button class="btn-primary" data-rerun="1">${icon('play')} 처음부터 다시 실행</button>
              ${run.bestIteration != null ? `<button class="ctl-btn resume" data-continue="1">${icon('play')} 베스트에서 이어하기</button>` : ''}
              <a class="btnlink" href="/api/runs/${id}/log" target="_blank">자세한 로그 ↗</a>
            </div>
            <details class="err-raw"><summary class="muted">원본 메시지</summary><pre>${escapeHtml(run.message || '')}</pre></details>
          </div>` : ''}
          ${run.status === 'stopped_ratelimit' && run.resumeAt ? `<div class="hero-hint">⏳ Claude 사용 한도 — <strong>${new Date(run.resumeAt).toLocaleString()}</strong> 이후 ${run.config && run.config.autoResume ? '자동 이어하기 예약됨' : '"이어하기"로 계속'}</div>` : ''}
          ${run.status === 'stopped_cost' ? `<div class="hero-hint">💰 비용 상한 도달 — "이어하기"로 계속하거나 상한을 올려 재실행하세요</div>` : ''}
          ${stepperHtml(run)}
          ${run.bestScore != null && !isError ? `<a class="btn-primary" href="/api/runs/${id}/best" target="_blank">${icon('doc')} 개선본 보기</a>` : ''}
        </div>
      </section>`;
  }

  const its = run.iterations || [];
  $(mountSel).innerHTML = `
    <div class="detail-head"><h1>${escapeHtml(run.title)}</h1></div>
    <div class="detail-sub">${statusTag(run.status, true)} <span class="kind-tag">${run.input.kind}</span> ${escapeHtml(run.input.source)}</div>

    ${renderAlert(run)}
    ${hero}
    ${costGaugeHtml(run)}
    <div class="tele-strip">${telemetryStrip(run)}</div>

    ${its.length ? `<div class="card"><h2>${icon('bars')} 점수 추이</h2>${scoreChartHtml(run)}</div>` : ''}

    ${stageGanttHtml(run)}

    <div class="card">
      <h2>${icon('ledger')} 다듬은 항목 <span class="right" id="ledger-prog"></span></h2>
      <div id="ledger"></div>
    </div>

    <div class="grid-2">
      <div class="card">
        <h2>${icon('bars')} 평가 ${best ? `<span class="right">${best.iteration}번째 기준</span>` : ''}</h2>
        <div id="dims" class="dim-bars"></div>
      </div>
      <div class="card">
        <h2>${icon('target')} 아직 손볼 곳</h2>
        <ul id="issues" class="issues"></ul>
      </div>
    </div>

    <div class="card">
      <h2>${icon('doc')} 미리보기 — <span id="iter-sel">${selectedIter != null ? selectedIter + '번째' : '-'}</span>
        <span class="right">
          ${run.bestScore != null ? `<a class="btnlink" href="/api/runs/${id}/best" target="_blank">개선본 열기 ↗</a>` : ''}
          ${run.input.kind === 'code' ? `<a class="btnlink" href="/api/runs/${id}/best/diff" target="_blank">${icon('download')} 패치(.diff)</a>` : ''}
          ${run.input.origFormat ? `<a class="btnlink" href="/api/runs/${id}/best/office">${icon('download')} ${run.officeInPlace ? '원본 양식' : ''}.${run.input.origFormat}</a>` : ''}
          ${run.officeInPlace ? `<a class="btnlink" href="/api/runs/${id}/best/office-clean">${icon('download')} 정리본 .${run.input.origFormat}</a>` : ''}
          ${run.changeLog && run.changeLog.length ? `<a class="btnlink" href="/api/runs/${id}/best/changes" target="_blank">변경 내역 ↗</a>${run.input.origFormat ? `<a class="btnlink" href="/api/runs/${id}/best/changes-office">${icon('download')} 변경요약 .${run.input.origFormat}</a>` : ''}` : ''}
        </span>
      </h2>
      <div class="tabs">
        <div class="tab ${activeTab === 'review' ? 'active' : ''}" data-tab="review">리뷰</div>
        <div class="tab ${activeTab === 'artifact' ? 'active' : ''}" data-tab="artifact">개선본</div>
        <div class="tab ${activeTab === 'stepdiff' ? 'active' : ''}" data-tab="stepdiff">이 초안 변경점</div>
        <div class="tab ${activeTab === 'diff' ? 'active' : ''}" data-tab="diff">원본과 비교</div>
        ${run.changeLog && run.changeLog.length ? `<div class="tab ${activeTab === 'changes' ? 'active' : ''}" data-tab="changes">변경 내역</div>` : ''}
      </div>
      <div id="viewer" class="viewer"></div>
    </div>

    <details class="card collapsible" ${working ? 'open' : ''}>
      <summary>${icon('history')} 초안 기록 <span class="muted">(${its.length}회)</span></summary>
      <table>
        <thead><tr><th>초안</th><th>점수</th><th>채택</th><th>모델</th><th>소요</th><th>토큰</th><th>메모</th></tr></thead>
        <tbody id="iter-rows"></tbody>
      </table>
    </details>

    ${tokenCardHtml(run)}

    <details class="card collapsible" ${working ? 'open' : ''}>
      <summary>${icon('terminal')} 진행 기록</summary>
      <div class="log-tools"><a class="btnlink" href="/api/runs/${id}/log" target="_blank">전체 로그 ↗</a></div>
      <div id="log" class="log"></div>
    </details>
  `;

  document.querySelectorAll('.hero-controls .ctl-btn[data-act]').forEach((b) => {
    b.onclick = () => controlRun(run.id, b.dataset.act);
  });
  document.querySelectorAll('.hero-controls .ctl-btn[data-continue]').forEach((b) => {
    b.onclick = () => continueRun(run.id);
  });
  // U7: 에러 카드의 다시 실행 / 이어하기 버튼
  document.querySelectorAll('.err-card [data-rerun]').forEach((b) => {
    b.onclick = () => rerunRun(run.id);
  });
  document.querySelectorAll('.err-card [data-continue]').forEach((b) => {
    b.onclick = () => continueRun(run.id);
  });
  bindAlertActions(run);
  attachChartHover($(mountSel));
  renderDims(best);
  renderLedger(run);
  renderIssues(best, run);
  renderIterRows(run);
  renderLog(run);
  bindTabs(run);
  if (working) setupLiveTicker(run, avgMs);
  else stopLiveTicker();
  await renderViewer(run);
}

// ── A/B 비교 뷰: 같은 groupId 의 두 변형을 나란히 ──
function renderCompare(run) {
  const gid = run.compare.groupId;
  const group = runs.filter((r) => r.compare && r.compare.groupId === gid);
  const a = group.find((r) => r.compare.variant === 'A');
  const b = group.find((r) => r.compare.variant === 'B');
  let better = null;
  if (a && b && a.bestScore != null && b.bestScore != null && a.bestScore !== b.bestScore) {
    better = a.bestScore > b.bestScore ? 'A' : 'B';
  }
  // 하단에서 볼 뷰 — 기본은 "차이 비교"
  if (!['diff', 'A', 'B'].includes(cmpVariant)) cmpVariant = 'diff';
  const labelA = (a && a.compare.label) || 'A';
  const labelB = (b && b.compare.label) || 'B';
  $('#detail').innerHTML = `
    <div class="detail-head"><h1>A/B 비교</h1></div>
    <div class="detail-sub"><span class="kind-tag">${run.input.kind}</span> ${escapeHtml(run.input.source)}</div>
    <div class="cmp-grid">
      ${cmpCol(a, 'A', better)}
      ${cmpCol(b, 'B', better)}
    </div>
    <div class="cmp-switch">
      <span class="cmp-switch-label">보기</span>
      <div class="cmp-tabs">
        <button class="cmp-tab" data-v="diff">차이 비교</button>
        <button class="cmp-tab" data-v="A">A · ${escapeHtml(labelA)}</button>
        <button class="cmp-tab" data-v="B">B · ${escapeHtml(labelB)}</button>
      </div>
    </div>
    <div id="cmp-body"></div>`;
  document.querySelectorAll('.cmp-tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.v === cmpVariant);
    t.onclick = () => {
      if (cmpVariant === t.dataset.v) return;
      cmpVariant = t.dataset.v;
      selectedIter = null;
      activeTab = 'review';
      renderCompare(run);
    };
  });
  if (cmpVariant === 'diff') {
    renderCmpDiff(a, b);
  } else {
    const sel = cmpVariant === 'B' ? b : a;
    if (sel) {
      const hasIter = sel.iterations && sel.iterations.some((i) => i.iteration === selectedIter);
      if (!hasIter) selectedIter = sel.bestIteration ?? sel.currentIteration ?? null;
      renderNormalDetail(sel, '#cmp-body');
    } else {
      $('#cmp-body').innerHTML = '<div class="card muted">이 변형은 아직 시작되지 않았어요.</div>';
    }
  }
}

// 베스트 회차의 차원 점수
function dimsOf(r) {
  if (!r || r.bestIteration == null) return {};
  const it = (r.iterations || []).find((i) => i.iteration === r.bestIteration);
  return (it && it.dimensions) || {};
}
// A/B 차이 뷰: 항목별 점수 대비 + 개선본 텍스트 diff
function renderCmpDiff(a, b) {
  const el = $('#cmp-body');
  if (!el) return;
  if (!a || !b) {
    el.innerHTML = '<div class="card muted">두 변형이 모두 끝나야 차이를 비교할 수 있어요.</div>';
    return;
  }
  const da = dimsOf(a), db = dimsOf(b);
  const keys = [...new Set([...Object.keys(da), ...Object.keys(db)])];
  // 점수(0~100) 행 — 높을수록 좋음
  const row = (name, av, bv) => {
    const A = av == null ? null : Math.round(av);
    const B = bv == null ? null : Math.round(bv);
    const d = A != null && B != null ? B - A : null;
    const aWin = A != null && B != null && A > B;
    const bWin = A != null && B != null && B > A;
    return `<div class="vs-row">
      <div class="vs-name">${escapeHtml(name)}</div>
      <div class="vs-val ${aWin ? 'win' : ''}">${A ?? '–'}</div>
      <div class="vs-track"><span class="vs-fill vs-a" style="width:${A || 0}%"></span><span class="vs-fill vs-b" style="width:${B || 0}%"></span></div>
      <div class="vs-val ${bWin ? 'win' : ''}">${B ?? '–'}</div>
      <div class="vs-delta ${d > 0 ? 'up' : d < 0 ? 'down' : ''}">${d == null ? '' : d > 0 ? '+' + d : d}</div>
    </div>`;
  };
  // 지표 행 — 단위·방향(낮을수록/높을수록 좋음) 지정. 막대는 둘 중 큰 값 기준 스케일.
  const metric = (name, A, B, dir, fmt) => {
    const max = Math.max(A, B, 0) || 1;
    const aWin = dir === 'lower' ? A < B : dir === 'higher' ? A > B : false;
    const bWin = dir === 'lower' ? B < A : dir === 'higher' ? B > A : false;
    const d = B - A;
    let dcls = '';
    if (d !== 0 && dir !== 'neutral') dcls = (dir === 'lower' && d < 0) || (dir === 'higher' && d > 0) ? 'up' : 'down';
    const dtxt = d === 0 ? '' : (d > 0 ? '+' : '−') + fmt(Math.abs(d));
    return `<div class="vs-row">
      <div class="vs-name">${escapeHtml(name)}</div>
      <div class="vs-val ${aWin ? 'win' : ''}">${fmt(A)}</div>
      <div class="vs-track"><span class="vs-fill vs-a" style="width:${(A / max) * 100}%"></span><span class="vs-fill vs-b" style="width:${(B / max) * 100}%"></span></div>
      <div class="vs-val ${bWin ? 'win' : ''}">${fmt(B)}</div>
      <div class="vs-delta ${dcls}">${dtxt}</div>
    </div>`;
  };
  const openCnt = (r) => (r.findings || []).filter((f) => f.status === 'open').length;
  const resolvedCnt = (r) => (r.findings || []).filter((f) => f.status === 'resolved').length;
  const num = (v) => String(v);
  const usd = (v) => '$' + Number(v).toFixed(4);

  el.innerHTML = `
    <div class="card">
      <h2>${icon('bars')} 점수 차이 <span class="right"><span class="vs-legend"><i class="vs-a"></i>A</span> <span class="vs-legend"><i class="vs-b"></i>B</span></span></h2>
      <div class="vs-head"><div class="vs-name">항목</div><div class="vs-val">A</div><div class="vs-track"></div><div class="vs-val">B</div><div class="vs-delta">B–A</div></div>
      <div class="vs-overall">${row('종합 점수', a.bestScore, b.bestScore)}</div>
      ${keys.length ? keys.map((k) => row(k, da[k], db[k])).join('') : '<div class="muted" style="padding:8px 0">차원 점수 데이터가 없어요.</div>'}
    </div>
    <div class="card">
      <h2>${icon('target')} 지표 차이</h2>
      <div class="vs-head"><div class="vs-name">지표</div><div class="vs-val">A</div><div class="vs-track"></div><div class="vs-val">B</div><div class="vs-delta">B–A</div></div>
      ${metric('다듬은 횟수', a.currentIteration || 0, b.currentIteration || 0, 'neutral', num)}
      ${metric('다듬은 항목', resolvedCnt(a), resolvedCnt(b), 'higher', num)}
      ${metric('남은 지적', openCnt(a), openCnt(b), 'lower', num)}
      ${metric('누적 비용', a.totalCostUsd || 0, b.totalCostUsd || 0, 'lower', usd)}
    </div>
    <div class="card">
      <h2>${icon('doc')} 개선본 차이 <span class="right muted">A(− 빨강) → B(+ 초록)</span></h2>
      <div id="cmp-artdiff" class="viewer"><span class="muted">불러오는 중…</span></div>
    </div>`;
  Promise.all([fetchText('/api/runs/' + a.id + '/best'), fetchText('/api/runs/' + b.id + '/best')]).then(([ta, tb]) => {
    const v = $('#cmp-artdiff');
    if (v) v.innerHTML = ta || tb ? renderDiff(ta, tb) : '<span class="muted">개선본이 아직 없어요.</span>';
  });
}
function cmpCol(r, variant, better) {
  if (!r) {
    return `<div class="card cmp-col"><div class="cmp-col-head"><span class="cmp-tag">${variant}</span> 준비 중…</div><div class="muted">아직 시작되지 않았어요.</div></div>`;
  }
  const open = (r.findings || []).filter((f) => f.status === 'open');
  const label = (r.compare && r.compare.label) || variant;
  const isBetter = better === variant;
  return `<div class="card cmp-col ${isBetter ? 'cmp-best' : ''}">
    <div class="cmp-col-head"><span class="cmp-tag">${variant}</span><span class="cmp-label">${escapeHtml(label)}</span>${isBetter ? '<span class="cmp-win">더 높은 점수</span>' : ''}</div>
    <div class="cmp-score"><div class="ring" style="--p:${r.bestScore ?? 0}"><div class="ring-core">${r.bestScore ?? '—'}</div></div></div>
    <div class="cmp-meta">${statusTag(r.status)}</div>
    <div class="cmp-sub">총 ${r.currentIteration}번 다듬음 · 손볼 항목 ${open.length}건</div>
    ${r.bestScore != null ? `<a class="btnlink" href="/api/runs/${r.id}/best" target="_blank">개선본 보기 ↗</a>` : ''}
  </div>`;
}

function renderAlert(run) {
  if (!run.alert || run.status !== 'paused') return '';
  const a = run.alert;
  const issues = (a.issues || []).map((i) => `<li>${escapeHtml(i)}</li>`).join('');
  return `
    <div class="alert-banner">
      <div class="alert-head">
        <span class="alert-ico">${icon('alert')}</span>
        <span class="alert-title">${escapeHtml(a.title)}</span>
      </div>
      <div class="alert-msg">${escapeHtml(a.message)}</div>
      ${issues ? `<div class="alert-label">반복된 문제</div><ul class="alert-issues">${issues}</ul>` : ''}
      <div class="alert-actions">
        <button class="ctl-btn resume" data-act="resume">${icon('play')} 확인하고 재개</button>
        <button class="ctl-btn stop" data-act="stop">${icon('stop')} 여기서 중단</button>
      </div>
    </div>`;
}
function bindAlertActions(run) {
  document.querySelectorAll('.alert-actions .ctl-btn').forEach((b) => {
    b.onclick = () => controlRun(run.id, b.dataset.act);
  });
}

let ledgerSevFilter = 'all'; // #12: 심각도 필터(all/high/medium/low)
function renderLedger(run) {
  const el = $('#ledger');
  const prog = $('#ledger-prog');
  if (!el) return;
  const findings = run.findings || [];
  const sevOf = (f) => f.severity || 'medium';
  const passSev = (f) => ledgerSevFilter === 'all' || sevOf(f) === ledgerSevFilter;
  const open = findings.filter((f) => f.status === 'open' && passSev(f));
  const resolved = findings.filter((f) => f.status === 'resolved' && passSev(f));
  const total = findings.length;
  const pct = total ? Math.round((resolved.length / total) * 100) : 0;
  if (prog) prog.innerHTML = total
    ? `<strong>${resolved.length}</strong> / ${total} 해결 &nbsp; <a class="btnlink" href="/api/runs/${run.id}/findings" target="_blank">목록(.md) 열기 ↗</a>`
    : '';

  if (!total) {
    el.innerHTML = '<span class="muted">아직 찾은 항목이 없어요. 첫 초안을 다듬고 나면 여기에 하나씩 쌓여요.</span>';
    return;
  }
  const sev = (s) => `<span class="sev sev-${s || 'medium'}">${s || 'medium'}</span>`;
  const openHtml = open.length
    ? open
        .map(
          (f) => `<li class="lf open lf-click" data-fid="${f.id}" title="개선본에서 위치 보기">
            <span class="mark"></span><span class="lf-id">#${f.id}</span>${sev(f.severity)}
            <span class="lf-title">${escapeHtml(f.title)}</span>
            <span class="lf-meta">${f.foundIter}번째 발견</span></li>`,
        )
        .join('')
    : '<li class="muted">손볼 항목이 없어요 — 전부 다듬었어요</li>';
  const resHtml = resolved
    .map(
      (f) => `<li class="lf done lf-click" data-fid="${f.id}" title="개선본에서 위치 보기">
        <span class="mark">${icon('check')}</span><span class="lf-id">#${f.id}</span>${sev(f.severity)}
        <span class="lf-title">${escapeHtml(f.title)}</span>
        <span class="lf-meta">${f.foundIter}→${f.resolvedIter}번째</span></li>`,
    )
    .join('');

  const chip = (v, label) => `<button class="sev-chip ${ledgerSevFilter === v ? 'on' : ''}" data-sev="${v}">${label}</button>`;
  el.innerHTML = `
    <div class="ledger-bar"><span style="width:${pct}%"></span></div>
    <div class="sev-filter">${chip('all', '전체')}${chip('high', 'high')}${chip('medium', 'medium')}${chip('low', 'low')}</div>
    <div class="ledger-col-title">손볼 항목 (${open.length})</div>
    <ul class="ledger-list">${openHtml}</ul>
    ${resolved.length ? `<details class="ledger-done"><summary>다듬은 항목 (${resolved.length})</summary><ul class="ledger-list">${resHtml}</ul></details>` : ''}
  `;
  el.querySelectorAll('.sev-chip').forEach((b) => {
    b.onclick = () => { ledgerSevFilter = b.dataset.sev; renderLedger(run); };
  });
  // #C: 지적 클릭 → 개선본에서 위치 강조
  el.querySelectorAll('.lf-click').forEach((li) => {
    li.onclick = () => {
      const f = (run.findings || []).find((x) => String(x.id) === li.dataset.fid);
      if (f) focusFinding(run, f);
    };
  });
}

// #C: 지적 제목 속 인용구를 추출(없으면 null)
function extractQuote(s) {
  const m = String(s || '').match(/[‘“"'「]([^’”"'」\n]{2,60})[’”"'」]/);
  return m ? m[1].trim() : null;
}
// #C: 본문(escape 후)에서 인용구를 <mark> 로 강조
function highlightInText(txt, q) {
  const safe = escapeHtml(txt);
  if (!q) return safe;
  const sq = escapeHtml(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    return safe.replace(new RegExp(sq, 'g'), (m) => `<mark class="find-hit">${m}</mark>`);
  } catch {
    return safe;
  }
}
// #C: 지적을 개선본 탭에서 위치로 연결
function focusFinding(run, f) {
  highlightQuery = extractQuote(f.title);
  activeTab = 'artifact';
  document.querySelectorAll('.tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === 'artifact'));
  renderViewer(run).then(() => {
    const v = $('#viewer');
    if (!v) return;
    const hit = v.querySelector('.find-hit');
    if (hit) hit.scrollIntoView({ block: 'center', behavior: 'smooth' });
    else v.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
}

function renderDims(best) {
  const el = $('#dims');
  if (!el) return;
  if (!best || !best.dimensions || !Object.keys(best.dimensions).length) {
    el.innerHTML = '<span class="muted">데이터 없음</span>';
    return;
  }
  el.innerHTML = Object.entries(best.dimensions)
    .map(
      ([k, v]) => `
    <div class="dim-row">
      <span class="dim-name">${escapeHtml(k)}</span>
      <span class="dim-track"><span class="dim-fill" style="width:${v}%;background:${scoreColor(v)}"></span></span>
      <span class="dim-val" style="color:${scoreColor(v)}">${v}</span>
    </div>`,
    )
    .join('');
}

function renderIssues(best, run) {
  const el = $('#issues');
  if (!el) return;
  const last = run.iterations[run.iterations.length - 1];
  const issues = (best && best.remainingIssues) || (last && last.remainingIssues) || [];
  el.innerHTML = issues.length
    ? issues.map((i) => `<li>${escapeHtml(i)}</li>`).join('')
    : '<li class="muted">없음 — 더 개선할 포인트가 보고되지 않았습니다.</li>';
}

function renderIterRows(run) {
  const tb = $('#iter-rows');
  if (!tb) return;
  tb.innerHTML = run.iterations
    .map(
      (it) => `
    <tr class="iter-row ${it.iteration === selectedIter ? 'active' : ''}" data-iter="${it.iteration}">
      <td>${it.iteration}번째</td>
      <td><span class="score-pill" style="color:${scoreColor(it.score)}">${it.score}<span class="score-mini"><span style="width:${it.score}%;background:${scoreColor(it.score)}"></span></span></span></td>
      <td class="${it.kept ? 'kept-yes' : 'kept-no'}">${it.kept ? '✓ 채택' : '·'}</td>
      <td>${escapeHtml(prettyModel(it.model) || '—')}</td>
      <td>${(it.durationMs / 1000).toFixed(1)}s</td>
      <td>${it.tokens ? `<span title="입력 ${it.tokens.input.toLocaleString()} · 출력 ${it.tokens.output.toLocaleString()} · 캐시읽기 ${it.tokens.cacheRead.toLocaleString()} · 캐시쓰기 ${it.tokens.cacheWrite.toLocaleString()}">${fmtTok(tokTotal(it.tokens))}</span>` : '–'}</td>
      <td>${escapeHtml((it.rationale || '').slice(0, 70))}</td>
    </tr>`,
    )
    .join('');
  tb.querySelectorAll('.iter-row').forEach((row) => {
    row.onclick = () => {
      selectedIter = parseInt(row.dataset.iter, 10);
      $('#iter-sel').textContent = '#' + selectedIter;
      tb.querySelectorAll('.iter-row').forEach((r) => r.classList.remove('active'));
      row.classList.add('active');
      renderViewer(run);
    };
  });
}

function renderLog(run) {
  const el = $('#log');
  if (!el) return;
  el.innerHTML = (run.log || [])
    .slice(-120)
    .map(
      (l) =>
        `<div class="l-${l.level}"><span class="ts">${l.ts.slice(11, 19)}</span>${escapeHtml(l.msg)}</div>`,
    )
    .join('');
  el.scrollTop = el.scrollHeight;
}

function bindTabs(run) {
  document.querySelectorAll('.tab').forEach((t) => {
    t.onclick = () => {
      activeTab = t.dataset.tab;
      highlightQuery = null; // 탭 직접 전환 시 지적 강조 해제
      document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      renderViewer(run);
    };
  });
}

function clip(s, n = 200) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}
// 변경 내역 카드 렌더(run.changeLog)
function renderChanges(run) {
  const log = run.changeLog || [];
  if (!log.length) return '<span class="muted">아직 변경 내역이 없어요.</span>';
  return log
    .map(
      (c, i) => `<div class="chg">
        <div class="chg-head"><span class="chg-n">${i + 1}</span><span class="chg-reason">${escapeHtml(c.reason || '수정')}</span>${c.findingId ? `<span class="chg-fid">지적 #${c.findingId}</span>` : ''}<span class="chg-iter">${c.iter}번째</span></div>
        <div class="chg-row chg-del">− ${escapeHtml(clip(c.find))}</div>
        <div class="chg-row chg-add">＋ ${c.replace && c.replace.trim() ? escapeHtml(clip(c.replace)) : '(삭제)'}</div>
      </div>`,
    )
    .join('');
}

// U2: 원본↔개선본 비교 뷰 모드('render' 렌더 2분할 / 'text' 텍스트 차이). 렌더 가능한 타입에서만 토글.
let diffView = 'render';
function cmpToggleHtml(active) {
  const seg = (v, label) => `<button class="seg ${active === v ? 'active' : ''}" data-view="${v}">${label}</button>`;
  return `<div class="cmp-toggle">${seg('render', '🖼 렌더 비교')}${seg('text', '📝 텍스트 차이')}</div>`;
}
function bindCmpToggle(run) {
  document.querySelectorAll('#viewer .cmp-toggle .seg').forEach((b) => {
    b.onclick = () => { diffView = b.dataset.view; renderViewer(run); };
  });
}

async function renderViewer(run) {
  const el = $('#viewer');
  if (!el) return;
  if (activeTab === 'changes') {
    el.innerHTML = renderChanges(run);
    return;
  }
  if (selectedIter == null) {
    el.innerHTML = '<span class="muted">회차를 선택하세요.</span>';
    return;
  }
  const base = `/api/runs/${run.id}/iterations/${selectedIter}`;
  if (activeTab === 'review') {
    const md = await fetchText(base + '/review');
    el.innerHTML = `<div class="md">${renderMarkdown(md)}</div>`;
  } else if (activeTab === 'artifact') {
    const txt = await fetchText(base + '/artifact');
    const ext = (run.input.ext || '').toLowerCase();
    // svg/html 은 소스 대신 '실제 렌더 모습'을 보여준다(스크립트 차단 샌드박스). 소스는 접이식으로 함께.
    if (ext === 'svg' || ext === 'html' || ext === 'htm') {
      const dl = `improved.${ext}`;
      el.innerHTML =
        `<div class="art-bar"><a class="btnlink" download="${dl}" href="${base}/artifact">${icon('download')} ${dl} 받기</a></div>` +
        `<iframe class="art-frame" sandbox style="width:100%;height:520px;border:1px solid var(--border,#ddd);border-radius:8px;background:#fff"></iframe>` +
        `<details class="art-src"><summary class="muted">소스 보기</summary><pre></pre></details>`;
      el.querySelector('.art-frame').srcdoc = txt;
      el.querySelector('.art-src pre').textContent = txt;
    } else {
      el.innerHTML = `<pre>${highlightInText(txt, highlightQuery)}</pre>`;
    }
  } else if (activeTab === 'stepdiff') {
    // 이 초안에서 직전 초안(1번째면 원본) 대비 무엇이 바뀌었는지
    const prev = selectedIter - 1;
    const prevUrl = prev >= 1 ? `/api/runs/${run.id}/iterations/${prev}/artifact` : `/api/runs/${run.id}/input`;
    const [a, b] = await Promise.all([fetchText(prevUrl), fetchText(base + '/artifact')]);
    const label = prev >= 1 ? `${prev}번째 → ${selectedIter}번째 초안` : `원본 → ${selectedIter}번째 초안`;
    const body = renderDiff(a, b);
    el.innerHTML = `<div class="diff-head">${label} <span class="muted">· <span class="dh-del">− 삭제</span> <span class="dh-add">+ 추가</span></span></div>${body && !/차이 없음/.test(body) ? body : '<span class="muted">이 초안에서 바뀐 내용이 없어요.</span>'}`;
  } else {
    const [orig, improved] = await Promise.all([
      fetchText('/api/runs/' + run.id + '/input'),
      fetchText(base + '/artifact'),
    ]);
    const ext = (run.input.ext || '').toLowerCase();
    const renderable = ext === 'svg' || ext === 'html' || ext === 'htm';
    if (!improved) {
      el.innerHTML = '<span class="muted">개선본이 아직 없어요.</span>';
    } else if (renderable && diffView === 'render') {
      // U2: 원본 vs 개선본을 실제 렌더로 나란히(스크립트 차단 샌드박스).
      el.innerHTML =
        cmpToggleHtml('render') +
        `<div class="render-cmp">
           <div class="rc-col"><div class="rc-h">원본</div><iframe class="rc-frame" sandbox></iframe></div>
           <div class="rc-col"><div class="rc-h rc-h-new">개선본</div><iframe class="rc-frame" sandbox></iframe></div>
         </div>`;
      const frames = el.querySelectorAll('.rc-frame');
      frames[0].srcdoc = orig;
      frames[1].srcdoc = improved;
      bindCmpToggle(run);
    } else {
      el.innerHTML = (renderable ? cmpToggleHtml('text') : '') + renderDiff(orig, improved);
      if (renderable) bindCmpToggle(run);
    }
  }
}


// ---------- 미니 마크다운 (제목/목록/번호목록/인용/표/코드/링크) ----------
function renderMarkdown(md) {
  if (!md) return '<span class="muted">없음</span>';
  const lines = md.split('\n');
  let html = '';
  let listType = null; // 'ul' | 'ol' | null
  let inCode = false;
  let inQuote = false;
  const closeList = () => { if (listType) { html += `</${listType}>`; listType = null; } };
  const closeQuote = () => { if (inQuote) { html += '</blockquote>'; inQuote = false; } };

  for (let i = 0; i < lines.length; i++) {
    let raw = lines[i];
    // 코드펜스
    if (raw.trim().startsWith('```')) {
      if (!inCode) { closeList(); closeQuote(); html += '<pre class="code">'; inCode = true; }
      else { html += '</pre>'; inCode = false; }
      continue;
    }
    if (inCode) { html += escapeHtml(raw) + '\n'; continue; }

    // GFM 표: 헤더행 + 구분행(|---|---|) 이 이어지면 표로 렌더.
    if (/^\s*\|.*\|\s*$/.test(raw) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      closeList(); closeQuote();
      const header = splitRow(raw);
      i++; // 구분행 소비
      let t = '<table class="md-table"><thead><tr>' + header.map((c) => `<th>${inlineMd(escapeHtml(c))}</th>`).join('') + '</tr></thead><tbody>';
      while (i + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[i + 1])) {
        const cells = splitRow(lines[++i]);
        t += '<tr>' + header.map((_, ci) => `<td>${inlineMd(escapeHtml(cells[ci] ?? ''))}</td>`).join('') + '</tr>';
      }
      html += t + '</tbody></table>';
      continue;
    }

    // 인용
    if (/^\s*>\s?/.test(raw)) {
      closeList();
      if (!inQuote) { html += '<blockquote>'; inQuote = true; }
      html += '<p>' + inlineMd(escapeHtml(raw.replace(/^\s*>\s?/, ''))) + '</p>';
      continue;
    }
    closeQuote();

    if (/^### /.test(raw)) { closeList(); html += '<h3>' + inlineMd(escapeHtml(raw.slice(4))) + '</h3>'; }
    else if (/^## /.test(raw)) { closeList(); html += '<h2>' + inlineMd(escapeHtml(raw.slice(3))) + '</h2>'; }
    else if (/^# /.test(raw)) { closeList(); html += '<h1>' + inlineMd(escapeHtml(raw.slice(2))) + '</h1>'; }
    else if (/^\s*\d+[.)] /.test(raw)) {
      if (listType !== 'ol') { closeList(); html += '<ol>'; listType = 'ol'; }
      html += '<li>' + inlineMd(escapeHtml(raw.replace(/^\s*\d+[.)] /, ''))) + '</li>';
    }
    else if (/^\s*[-*+] /.test(raw)) {
      if (listType !== 'ul') { closeList(); html += '<ul>'; listType = 'ul'; }
      html += '<li>' + inlineMd(escapeHtml(raw.replace(/^\s*[-*+] /, ''))) + '</li>';
    }
    else if (raw.trim() === '') { closeList(); }
    else { closeList(); html += '<p>' + inlineMd(escapeHtml(raw)) + '</p>'; }
  }
  closeList();
  closeQuote();
  if (inCode) html += '</pre>';
  return html;
}
// "| a | b |" → ['a','b'] (양끝 파이프 제거, 이스케이프된 파이프 \| 보존)
function splitRow(row) {
  return row.trim().replace(/^\|/, '').replace(/\|$/, '')
    .split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}
function inlineMd(s) {
  return s
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // 링크 [text](url) — escapeHtml 이후라 안전한 스킴만 허용(javascript: 등 차단)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, url) =>
      /^(https?:|mailto:|\/|#|&amp;)/i.test(url) || /^[\w./-]+$/.test(url)
        ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`
        : text);
}

// ---------- 라인 단위 diff (간단 LCS) ----------
function renderDiff(a, b) {
  const A = (a || '').split('\n');
  const B = (b || '').split('\n');
  const m = A.length, n = B.length;
  if (m * n > 4_000_000) {
    return `<div class="muted">파일이 커서 diff 생략. 개선본/원본 탭을 직접 비교하세요.</div>`;
  }
  // 라인 단위 LCS → 연산 시퀀스
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (A[i] === B[j]) { ops.push(['eq', A[i]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push(['del', A[i]]); i++; }
    else { ops.push(['add', B[j]]); j++; }
  }
  while (i < m) ops.push(['del', A[i++]]);
  while (j < n) ops.push(['add', B[j++]]);

  // 삭제런+추가런을 짝지어 "수정된 줄"은 단어 단위로 하이라이트, eq 줄은 접기 대상.
  let body = '', changed = 0, k = 0;
  while (k < ops.length) {
    if (ops[k][0] === 'eq') { body += diffLineHtml('diff-eq', ' ', escapeHtml(ops[k][1])); k++; continue; }
    const dels = [], adds = [];
    while (k < ops.length && ops[k][0] === 'del') dels.push(ops[k++][1]);
    while (k < ops.length && ops[k][0] === 'add') adds.push(ops[k++][1]);
    body += renderChangeBlock(dels, adds);
    changed += dels.length + adds.length;
  }
  if (!changed) return '<span class="muted">차이 없음</span>';
  return `<div class="diffwrap">
    <div class="difftools"><label class="diff-toggle"><input type="checkbox" onchange="toggleDiffOnlyChanged(this)"> 변경된 줄만 보기</label></div>
    <div class="diffbody">${body}</div>
  </div>`;
}

function diffLineHtml(cls, sign, innerHtml) {
  return `<div class="diff-line ${cls}"><span class="dsign">${sign}</span>${innerHtml}</div>`;
}

// 삭제/추가 묶음을 정렬해 비슷한 줄은 단어 단위로 짝지어 보여준다.
function renderChangeBlock(dels, adds) {
  let out = '';
  const p = Math.min(dels.length, adds.length);
  let di = 0, ai = 0;
  for (let k = 0; k < p; k++) {
    if (linesSimilar(dels[k], adds[k])) {
      const { delHtml, insHtml } = wordDiff(dels[k], adds[k]);
      out += diffLineHtml('diff-del', '-', delHtml) + diffLineHtml('diff-add', '+', insHtml);
    } else {
      out += diffLineHtml('diff-del', '-', escapeHtml(dels[k])) + diffLineHtml('diff-add', '+', escapeHtml(adds[k]));
    }
    di++; ai++;
  }
  for (; di < dels.length; di++) out += diffLineHtml('diff-del', '-', escapeHtml(dels[di]));
  for (; ai < adds.length; ai++) out += diffLineHtml('diff-add', '+', escapeHtml(adds[ai]));
  return out;
}

function tokenSetOf(s) {
  return new Set((s.toLowerCase().match(/[a-z0-9]+|[가-힣]{2,}/g) || []));
}
// 두 줄이 "수정된 한 줄"로 볼 만큼 비슷한가(토큰 겹침 비율).
function linesSimilar(a, b) {
  const ta = tokenSetOf(a), tb = tokenSetOf(b);
  if (!ta.size || !tb.size) return false;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / Math.max(ta.size, tb.size) >= 0.3;
}

// 한 줄 내부의 단어 단위 diff → 삭제/추가 토큰을 <span> 으로 강조.
function wordDiff(a, b) {
  const aw = a.split(/(\s+)/), bw = b.split(/(\s+)/);
  const m = aw.length, n = bw.length;
  if (m * n > 40_000) return { delHtml: escapeHtml(a), insHtml: escapeHtml(b) }; // 너무 긴 줄은 통째로
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = aw[i] === bw[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  let i = 0, j = 0, delHtml = '', insHtml = '';
  while (i < m && j < n) {
    if (aw[i] === bw[j]) { delHtml += escapeHtml(aw[i]); insHtml += escapeHtml(bw[j]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { delHtml += `<span class="w-del">${escapeHtml(aw[i++])}</span>`; }
    else { insHtml += `<span class="w-ins">${escapeHtml(bw[j++])}</span>`; }
  }
  while (i < m) delHtml += `<span class="w-del">${escapeHtml(aw[i++])}</span>`;
  while (j < n) insHtml += `<span class="w-ins">${escapeHtml(bw[j++])}</span>`;
  return { delHtml, insHtml };
}

// "변경된 줄만 보기" 토글(인라인 onchange 에서 호출 — 전역 함수)
function toggleDiffOnlyChanged(cb) {
  const wrap = cb.closest('.diffwrap');
  if (wrap) wrap.classList.toggle('only-changed', cb.checked);
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---------- 실시간 ----------
function connectSSE() {
  const es = new EventSource('/api/stream');
  es.addEventListener('hello', () => {
    $('#conn').classList.add('live');
    $('#conn .conn-text').textContent = '실시간';
  });
  es.addEventListener('change', (e) => {
    let ids = null; // U1: 바뀐 런 id 만 받아 해당 런을 볼 때만 상세 재렌더
    try { const d = JSON.parse(e.data || '{}'); if (Array.isArray(d.ids)) ids = d.ids; } catch { /* 구버전 서버 호환 */ }
    loadRuns(ids);
  });
  // P1/U1: 진행 중 생성 토큰 — 지금 보고 있는 런이면 라이브 박스에 흘려보낸다.
  es.addEventListener('live', (e) => {
    let m; try { m = JSON.parse(e.data || '{}'); } catch { return; }
    if (!m || m.runId !== selectedId) return;
    const box = document.getElementById('live-stream');
    if (!box) return;
    if (m.reset) { box.textContent = ''; box.classList.remove('done'); }
    if (typeof m.text === 'string') {
      const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
      box.textContent = m.text;
      if (atBottom) box.scrollTop = box.scrollHeight; // 따라 내려가되, 위로 올려 보면 방해 안 함
    }
    if (m.done) box.classList.add('done');
  });
  es.onerror = () => {
    $('#conn').classList.remove('live');
    $('#conn .conn-text').textContent = '연결 중…';
  };
}

initForm();
initShell();
restoreFormPrefs(); // #3: 마지막 설정 복원(선택 옵션들이 채워진 뒤)
// #14: 런 목록 검색
const _searchEl = $('#run-search');
if (_searchEl) _searchEl.addEventListener('input', () => { runQuery = _searchEl.value.trim().toLowerCase(); renderSidebar(); });
loadRuns();
connectSSE();
