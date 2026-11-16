// ===== 1. 설정값 =====
// 회사별 기본 모델. 모델이 바뀌면 설정 창에서 이름만 고치면 됩니다.
const DEFAULT_MODELS = {
  gemini: "gemini-flash-latest",
  openai: "gpt-5.4-mini",
  claude: "claude-haiku-5-5",
};

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

let settings = store.get("settings", { provider: "gemini", model: DEFAULT_MODELS.gemini, apiKey: "" });
let plan = store.get("plan", null);   // AI가 만든 결과
let done = store.get("done", {});     // 체크한 일정 { "날짜|시간|제목": true }
let activeDay = 0;

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

// ===== 3. 회사별 API 호출 =====
// 세 회사 모두 "글을 보내고 글을 받는다"는 건 같고, 주소·헤더·응답 모양만 다릅니다.
async function callAI(prompt) {
  const { provider, model, apiKey } = settings;
  let res, data;

  if (provider === "gemini") {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json" },
      }),
    });
    data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || res.status);
    return data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
  }

  if (provider === "openai") {
    res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
      }),
    });
    data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || res.status);
    return data.choices?.[0]?.message?.content ?? "";
  }

  if (provider === "claude") {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        // 브라우저에서 직접 부를 때 Anthropic이 요구하는 헤더
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || res.status);
    return data.content?.map((c) => c.text || "").join("") ?? "";
  }

  throw new Error("알 수 없는 AI 회사입니다.");
}

// AI가 JSON 앞뒤에 ```json 같은 글을 붙여도 { ... } 부분만 꺼냅니다.
function parseJSON(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("AI 응답에서 JSON을 찾지 못했습니다.");
  return JSON.parse(text.slice(start, end + 1));
}

// ===== 4. 버튼 동작 =====
async function makePlan() {
  const todoText = $("todoInput").value.trim();
  if (!todoText) return setStatus("할 일을 먼저 적어주세요.", true);
  if (!settings.apiKey) { $("settings").showModal(); return setStatus("API 키를 먼저 설정해주세요.", true); }

  const opt = {
    startDate: $("startDate").value,
    days: Math.min(14, Math.max(1, Number($("days").value) || 3)),
    dayStart: $("dayStart").value,
    dayEnd: $("dayEnd").value,
  };

  $("planBtn").disabled = true;
  setStatus("AI가 일정을 짜는 중...");
  try {
    const text = await callAI(buildPrompt(todoText, opt));
    plan = parseJSON(text);
    done = {};
    activeDay = 0;
    store.set("plan", plan);
    store.set("done", done);
    store.set("todoText", todoText);
    render();
    setStatus("완료!");
  } catch (err) {
    setStatus("오류: " + err.message, true);
  } finally {
    $("planBtn").disabled = false;
  }
}

// ===== 5. 화면 그리기 =====
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

// ===== 6. 작은 도우미 함수들 =====
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

// ===== 7. 이벤트 연결 =====
$("planBtn").addEventListener("click", makePlan);

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

$("settingsBtn").addEventListener("click", () => {
  $("provider").value = settings.provider;
  $("model").value = settings.model;
  $("apiKey").value = settings.apiKey;
  $("settings").showModal();
});

// 회사를 바꾸면 모델 이름을 그 회사 기본값으로 바꿔줍니다.
$("provider").addEventListener("change", () => {
  $("model").value = DEFAULT_MODELS[$("provider").value];
});

$("saveSettings").addEventListener("click", () => {
  settings = {
    provider: $("provider").value,
    model: $("model").value.trim() || DEFAULT_MODELS[$("provider").value],
    apiKey: $("apiKey").value.trim(),
  };
  store.set("settings", settings);
  setStatus("설정을 저장했어요.");
});

// ===== 8. 시작 =====
$("startDate").value = todayStr();
$("todoInput").value = store.get("todoText", "");
render();
