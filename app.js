// ===== 1. 저장소 & 상태 =====
// localStorage는 막혀 있는 환경도 있어서 try/catch로 감쌉니다.
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 저장 실패는 무시 */ }
  },
};

const $ = (id) => document.getElementById(id);

// models: 찾은 모델 목록(추천 순서), model: 우선 사용할 모델
let settings = store.get("settings", { provider: "gemini", apiKey: "", models: [], model: "" });
if (!Array.isArray(settings.models)) settings.models = [];   // 예전 버전 설정 호환

let cooldown = store.get("cooldown", {}); // { "회사:모델": 다시 써도 되는 시각(ms) }
let plan = store.get("plan", null);       // AI가 만든 결과
let done = store.get("done", {});         // 체크한 일정 { "날짜|시간|제목": true }
let activeDay = 0;

const COOLDOWN_MS = 60 * 60 * 1000;       // 한도 초과 모델은 1시간 동안 건너뜀

// ===== 2. AI에게 보낼 지시문 =====
function buildPrompt(todoText, opt) {
  return `너는 학생의 일정 관리 비서야. 아래 할 일 목록을 분석해서 일정표를 만들어.

[조건]
- 오늘(시작일): ${opt.startDate} (${weekday(opt.startDate)})
- 기간: 시작일부터 ${opt.days}일
- 활동 가능 시간: 매일 ${opt.dayStart} ~ ${opt.dayEnd}
- 마감이 가까운 일과 급한 일을 앞에 배치하고, 큰 일은 여러 블록으로 나눠.
- 고정 일정(예: "토요일 3시 치과")은 그 시간에 그대로 넣어.
- 블록 사이에 쉬는 시간을 적당히 넣고, 하루에 너무 몰아넣지 마.
- 모든 글은 한국어로.

[출력] 설명 없이 아래 형식의 JSON만 출력해.
{
  "summary": "전체 상황을 2~3문장으로 요약",
  "tasks": [
    { "title": "할 일", "priority": "high|mid|low", "due": "YYYY-MM-DD 또는 빈 문자열" }
  ],
  "schedule": [
    {
      "date": "YYYY-MM-DD",
      "items": [
        { "start": "HH:MM", "end": "HH:MM", "title": "할 일", "priority": "high|mid|low", "note": "짧은 팁(선택)" }
      ]
    }
  ]
}

[할 일 목록]
${todoText}`;
}

// ===== 3. 회사별 요청 정보 =====
// 🆕 객체 안에 함수를 넣어 "회사 이름 → 그 회사 방식"을 표처럼 정리했습니다.
//    if문을 여러 번 쓰는 대신 PROVIDERS[provider].chat(...) 한 줄로 부를 수 있어요.
const PROVIDERS = {
  gemini: {
    headers: (key) => ({ "Content-Type": "application/json", "x-goog-api-key": key }),
    listUrl: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
    // 응답에서 "글 생성이 되는 gemini 모델" 이름만 뽑습니다.
    pickModels: (data) => (data.models || [])
      .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
      .map((m) => m.name.replace("models/", "")),
    chatUrl: (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    chatBody: (model, prompt) => ({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json" },
    }),
    readText: (data) => data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "",
  },
  openai: {
    headers: (key) => ({ "Content-Type": "application/json", Authorization: `Bearer ${key}` }),
    listUrl: "https://api.openai.com/v1/models",
    pickModels: (data) => (data.data || []).map((m) => m.id),
    chatUrl: () => "https://api.openai.com/v1/chat/completions",
    chatBody: (model, prompt) => ({
      model,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    }),
    readText: (data) => data.choices?.[0]?.message?.content ?? "",
  },
  claude: {
    headers: (key) => ({
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      // 브라우저에서 직접 부를 때 Anthropic이 요구하는 헤더
      "anthropic-dangerous-direct-browser-access": "true",
    }),
    listUrl: "https://api.anthropic.com/v1/models?limit=1000",
    pickModels: (data) => (data.data || []).map((m) => m.id),
    chatUrl: () => "https://api.anthropic.com/v1/messages",
    chatBody: (model, prompt) => ({
      model,
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    }),
    readText: (data) => data.content?.map((c) => c.text || "").join("") ?? "",
  },
};

// 🆕 Error에 HTTP 상태 코드를 붙여서 던집니다. 받는 쪽에서 "왜 실패했는지"로 다음 행동을 고를 수 있어요.
class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function request(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error?.message || `HTTP ${res.status}`);
  return data;
}

// ===== 4. 모델 자동으로 찾기 =====
// 일정표 만들기에 맞지 않는 모델(이미지, 음성, 임베딩 등)을 이름으로 걸러냅니다.
const EXCLUDE = /image|tts|audio|realtime|transcribe|embed|live|search|moderation|instruct|codex|computer|robotics|research|banana|lyria|veo|imagen|dall-e|whisper|babbage|davinci/i;

function isChatModel(provider, id) {
  const prefix = { gemini: /^gemini/, openai: /^(gpt-|o\d|chatgpt)/, claude: /^claude/ }[provider];
  // OpenAI는 같은 모델의 날짜 붙은 버전(gpt-x-2025-01-01)이 잔뜩 있어서 빼줍니다.
  // Claude는 목록이 날짜 붙은 이름으로만 오는 경우가 있어서 빼면 안 됩니다.
  const dated = provider === "openai" && /-\d{4}-\d{2}-\d{2}$/.test(id);
  return prefix.test(id) && !EXCLUDE.test(id) && !dated;
}

// 추천 순서: 빠르고 저렴한 모델 → 더 가벼운 모델 → 큰 모델 / 같은 등급이면 최신 버전 먼저, 정식이 프리뷰보다 먼저
function rankModel(id) {
  let tier = 2;                                         // pro, sonnet, opus, 일반 gpt 등
  if (/lite|nano/.test(id)) tier = 1;
  else if (/flash|haiku|-mini/.test(id)) tier = 0;     // "gemini" 안에도 mini가 있어서 -mini로 구분
  if (/preview|exp/.test(id)) tier += 0.5;
  const num = id.match(/(\d+)(?:[.-](\d))?/);           // gemini-3.8 / gpt-5.4 / claude-haiku-5-5
  const version = /latest/.test(id) ? 999 : num ? Number(`${num[1]}.${num[2] || 0}`) : 0;
  return { tier, version };
}

function sortModels(ids) {
  return [...new Set(ids)].sort((a, b) => {
    const ra = rankModel(a), rb = rankModel(b);
    return ra.tier - rb.tier || rb.version - ra.version || a.localeCompare(b);
  });
}

async function findModels(provider, apiKey) {
  const p = PROVIDERS[provider];
  const data = await request(p.listUrl, { headers: p.headers(apiKey) });
  const models = sortModels(p.pickModels(data).filter((id) => isChatModel(provider, id)));
  if (!models.length) throw new Error("사용할 수 있는 모델을 찾지 못했습니다.");
  return models;
}

// ===== 5. 자동 전환하며 AI 호출 =====
// 실패 이유에 따라 다르게 행동합니다.
//  - 한도 초과(429): 그 모델을 1시간 쉬게 하고 다음 모델로
//  - 모델 없음(404): 목록에서 빼고 다음 모델로
//  - 서버 과부하(5xx): 다음 모델로
//  - 키 오류(401/403), 결제·크레딧 부족: 계정 문제라 모델을 바꿔도 소용없으니 즉시 멈춤
function isAccountProblem(err) {
  return err.status === 401 || err.status === 403 ||
    /insufficient_quota|credit balance|billing|API key not valid/i.test(err.message);
}

async function callWithFallback(prompt) {
  const { provider, apiKey } = settings;
  const p = PROVIDERS[provider];
  const now = Date.now();

  // 우선 모델을 맨 앞에 두고, 쉬는 중인 모델은 뒤로 미룹니다(다 쉬는 중이면 그래도 시도).
  const order = [settings.model, ...settings.models.filter((m) => m !== settings.model)].filter(Boolean);
  const ready = order.filter((m) => !(cooldown[`${provider}:${m}`] > now));
  const resting = order.filter((m) => cooldown[`${provider}:${m}`] > now);
  const queue = [...ready, ...resting];

  const skipped = [];
  for (const model of queue) {
    setStatus(`AI가 일정을 짜는 중... (${model})`);
    try {
      const data = await request(p.chatUrl(model), {
        method: "POST",
        headers: p.headers(apiKey),
        body: JSON.stringify(p.chatBody(model, prompt)),
      });
      return { text: p.readText(data), model, skipped };
    } catch (err) {
      if (!(err instanceof ApiError) || isAccountProblem(err)) throw err;

      if (err.status === 429) {
        cooldown[`${provider}:${model}`] = Date.now() + COOLDOWN_MS;
        store.set("cooldown", cooldown);
      } else if (err.status === 404) {
        settings.models = settings.models.filter((m) => m !== model);
        if (settings.model === model) settings.model = settings.models[0] || "";
        store.set("settings", settings);
      } else if (err.status < 500) {
        throw err;   // 그 외 요청 오류는 모델 문제가 아니므로 멈춤
      }
      skipped.push(model);
    }
  }
  throw new Error("모든 모델이 한도 초과이거나 사용할 수 없습니다. 잠시 후 다시 시도해주세요.");
}

// AI가 JSON 앞뒤에 ```json 같은 글을 붙여도 { ... } 부분만 꺼냅니다.
function parseJSON(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("AI 응답에서 JSON을 찾지 못했습니다.");
  return JSON.parse(text.slice(start, end + 1));
}

// ===== 6. 일정 만들기 버튼 =====
async function makePlan() {
  const todoText = $("todoInput").value.trim();
  if (!todoText) return setStatus("할 일을 먼저 적어주세요.", true);
  if (!settings.apiKey || !settings.models.length) {
    openSettings();
    return setStatus("API 키를 넣고 모델을 찾아주세요.", true);
  }

  const opt = {
    startDate: $("startDate").value,
    days: Math.min(14, Math.max(1, Number($("days").value) || 3)),
    dayStart: $("dayStart").value,
    dayEnd: $("dayEnd").value,
  };

  $("planBtn").disabled = true;
  try {
    const { text, model, skipped } = await callWithFallback(buildPrompt(todoText, opt));
    plan = parseJSON(text);
    done = {};
    activeDay = 0;
    store.set("plan", plan);
    store.set("done", done);
    store.set("todoText", todoText);
    render();
    setStatus(skipped.length
      ? `완료! (${skipped.join(", ")} 사용 불가 → ${model}로 자동 전환)`
      : `완료! (${model})`);
  } catch (err) {
    setStatus("오류: " + err.message, true);
  } finally {
    $("planBtn").disabled = false;
  }
}

// ===== 7. 화면 그리기 =====
function render() {
  if (!plan) return;
  $("result").classList.remove("hidden");
  $("summary").textContent = plan.summary || "";

  const order = { high: 0, mid: 1, low: 2 };
  const tasks = [...(plan.tasks || [])].sort((a, b) => (order[a.priority] ?? 3) - (order[b.priority] ?? 3));
  $("priorityList").innerHTML = tasks.map((t) => `
    <li>
      <span class="badge ${prio(t.priority)}">${prioLabel(t.priority)}</span>
      <span>${esc(t.title)}</span>
      ${t.due ? `<span class="due">~${esc(t.due)}</span>` : ""}
    </li>`).join("");

  const days = plan.schedule || [];
  $("dayTabs").innerHTML = days.map((d, i) => `
    <button data-i="${i}" class="${i === activeDay ? "active" : ""}">
      ${esc(d.date.slice(5))} (${weekday(d.date)})
    </button>`).join("");

  const items = (days[activeDay]?.items || []).slice().sort((a, b) => a.start.localeCompare(b.start));
  const date = days[activeDay]?.date || "";
  $("timeline").innerHTML = items.length ? items.map((it) => {
    const key = `${date}|${it.start}|${it.title}`;
    return `
    <li class="${prio(it.priority)} ${done[key] ? "done" : ""}">
      <span class="time">${esc(it.start)} – ${esc(it.end)}</span>
      <span class="title">${esc(it.title)}${it.note ? `<br><span class="note">${esc(it.note)}</span>` : ""}</span>
      <input type="checkbox" data-key="${esc(key)}" ${done[key] ? "checked" : ""} aria-label="완료">
    </li>`;
  }).join("") : `<li>이 날은 일정이 없어요.</li>`;
}

// ===== 8. 설정 창 =====
let foundModels = [];   // 설정 창에서 방금 찾은 목록(저장 전)

function fillModelSelect(models, selected) {
  $("model").innerHTML = models.length
    ? models.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join("")
    : `<option value="">먼저 모델을 찾아주세요</option>`;
  if (selected && models.includes(selected)) $("model").value = selected;
  $("modelInfo").textContent = models.length
    ? `${models.length}개 찾음 · 한도 초과 시 목록 순서대로 자동 전환`
    : "";
}

function openSettings() {
  $("provider").value = settings.provider;
  $("apiKey").value = settings.apiKey;
  foundModels = settings.models;
  fillModelSelect(foundModels, settings.model);
  $("settings").showModal();
}

async function onFindModels() {
  const provider = $("provider").value;
  const apiKey = $("apiKey").value.trim();
  if (!apiKey) { $("modelInfo").textContent = "API 키를 먼저 넣어주세요."; return false; }

  $("findModels").disabled = true;
  $("modelInfo").textContent = "모델을 찾는 중...";
  try {
    foundModels = await findModels(provider, apiKey);
    fillModelSelect(foundModels, foundModels[0]);
    return true;
  } catch (err) {
    $("modelInfo").textContent = "모델 찾기 실패: " + err.message;
    return false;
  } finally {
    $("findModels").disabled = false;
  }
}

async function onSaveSettings() {
  // 키나 회사가 바뀌었는데 모델을 아직 안 찾았다면 저장할 때 자동으로 찾습니다.
  const changed = $("provider").value !== settings.provider || $("apiKey").value.trim() !== settings.apiKey;
  if ((changed && foundModels === settings.models) || !foundModels.length) {
    if (!(await onFindModels())) return;   // 실패하면 창을 닫지 않음
  }
  settings = {
    provider: $("provider").value,
    apiKey: $("apiKey").value.trim(),
    models: foundModels,
    model: $("model").value || foundModels[0],
  };
  store.set("settings", settings);
  $("settings").close();
  setStatus("설정을 저장했어요.");
}

// ===== 9. 작은 도우미 함수들 =====
function setStatus(msg, isError = false) {
  $("status").textContent = msg;
  $("status").classList.toggle("error", isError);
}
function prio(p) { return ["high", "mid", "low"].includes(p) ? p : "low"; }
function prioLabel(p) { return { high: "급함", mid: "보통", low: "여유" }[prio(p)]; }
function weekday(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  return isNaN(d) ? "" : "일월화수목금토"[d.getDay()];
}
// AI가 준 글을 그대로 HTML에 넣으면 위험하니 특수문자를 바꿉니다.
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ===== 10. 이벤트 연결 =====
$("planBtn").addEventListener("click", makePlan);
$("settingsBtn").addEventListener("click", openSettings);
$("findModels").addEventListener("click", onFindModels);
$("saveSettings").addEventListener("click", onSaveSettings);

// 회사를 바꾸면 이전 회사의 모델 목록은 쓸 수 없으니 비웁니다.
$("provider").addEventListener("change", () => {
  foundModels = [];
  fillModelSelect([], "");
});

$("dayTabs").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  activeDay = Number(btn.dataset.i);
  render();
});

$("timeline").addEventListener("change", (e) => {
  if (e.target.type !== "checkbox") return;
  done[e.target.dataset.key] = e.target.checked;
  store.set("done", done);
  render();
});

// ===== 11. 시작 =====
$("startDate").value = todayStr();
$("todoInput").value = store.get("todoText", "");
render();
