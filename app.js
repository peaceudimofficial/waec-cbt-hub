let activeStudent = null;
let currentSubject = null;
let currentQuestions = [];
let currentIndex = 0;
let score = 0;
let selected = null;
let timer = null;
let seconds = 600;

const API = "/api";

function hideAll() {
  ["home","register","processing","success","subjects","quiz","result"]
    .forEach(id => document.getElementById(id).classList.add("hidden"));
}
function show(id) { hideAll(); document.getElementById(id).classList.remove("hidden"); }
function showHome() { show("home"); }
function showRegister() { show("register"); }

function setMessage(id, text) {
  document.getElementById(id).textContent = text || "";
}

async function api(action, payload = {}) {
  const res = await fetch(API, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({action, ...payload})
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || "Something went wrong.");
  return data;
}

function saveActive(student) {
  activeStudent = student;
  sessionStorage.setItem("waec_active", JSON.stringify(student));
}

function loadActive() {
  try {
    activeStudent = JSON.parse(sessionStorage.getItem("waec_active") || "null");
  } catch {
    activeStudent = null;
  }
}

async function login() {
  const code = document.getElementById("codeInput").value.trim().toUpperCase();
  setMessage("loginMsg", "");

  if (!code) {
    setMessage("loginMsg", "Enter your access code.");
    return;
  }

  try {
    const data = await api("login", {code});
    saveActive(data.student);
    await showSubjects();
  } catch (err) {
    setMessage("loginMsg", "Invalid or inactive access code. If you forgot your code, please register again.");
  }
}

async function startPayment() {
  const name = document.getElementById("studentName").value.trim();
  const email = document.getElementById("studentEmail").value.trim();
  const phone = document.getElementById("studentPhone").value.trim();
  const amount = Number(document.getElementById("package").value);

  setMessage("registerMsg", "");

  if (!name || !email || !phone) {
    setMessage("registerMsg", "Please complete all registration fields.");
    return;
  }

  const button = document.querySelector("#register button");
  button.disabled = true;

  try {
    const data = await api("create-payment", {name, email, phone, amount});
    window.location.href = data.authorization_url;
  } catch (err) {
    setMessage("registerMsg", err.message);
    button.disabled = false;
  }
}

async function verifyCallback() {
  const params = new URLSearchParams(window.location.search);
  const reference = params.get("reference") || params.get("trxref");

  if (!reference) return false;

  show("processing");

  try {
    const data = await api("verify-payment", {reference});
    document.getElementById("newCode").textContent = data.access_code;
    saveActive(data.student);
    history.replaceState({}, "", window.location.pathname);
    show("success");
    return true;
  } catch (err) {
    history.replaceState({}, "", window.location.pathname);
    showHome();
    setMessage("loginMsg", "We could not verify that payment yet. If you were charged, contact support with your Paystack reference.");
    return false;
  }
}

async function enterCBT() {
  await showSubjects();
}

async function showSubjects() {
  show("subjects");

  if (!activeStudent) {
    showHome();
    return;
  }

  const packageText = activeStudent.package === "4000"
    ? "All Subjects access"
    : activeStudent.package === "2500"
      ? "3 Subjects access"
      : "1 Subject access";

  document.getElementById("packageInfo").textContent = packageText;

  const box = document.getElementById("subjectList");
  box.innerHTML = "<p>Loading subjects…</p>";

  try {
    const data = await api("subjects", {student_id: activeStudent.id});
    box.innerHTML = "";

    data.subjects.forEach(subject => {
      const el = document.createElement("div");
      el.className = "subject";
      el.innerHTML = `<b>${escapeHtml(subject.name)}</b><span>WAEC-style practice</span>`;
      el.onclick = () => startQuiz(subject);
      box.appendChild(el);
    });

    if (!data.subjects.length) {
      box.innerHTML = "<p>No subjects are available yet.</p>";
    }
  } catch {
    box.innerHTML = "<p>Unable to load subjects. Please try again.</p>";
  }
}

async function startQuiz(subject) {
  currentSubject = subject;
  currentIndex = 0;
  score = 0;
  selected = null;
  seconds = 600;

  show("quiz");

  document.getElementById("question").textContent = "Loading questions…";
  document.getElementById("options").innerHTML = "";

  try {
    const data = await api("questions", {subject_id: subject.id});
    currentQuestions = data.questions || [];

    if (!currentQuestions.length) {
      document.getElementById("question").textContent =
        "Questions for this subject are not available yet.";
      document.getElementById("nextBtn").style.display = "none";
      return;
    }

    document.getElementById("nextBtn").style.display = "block";
    renderQuestion();
    startTimer();
  } catch {
    document.getElementById("question").textContent =
      "Unable to load questions.";
  }
}

function renderQuestion() {
  const item = currentQuestions[currentIndex];

  document.getElementById("progress").textContent =
    `Question ${currentIndex + 1} of ${currentQuestions.length}`;

  document.getElementById("question").textContent = item.question_text;

  const box = document.getElementById("options");
  box.innerHTML = "";
  selected = null;

  const options = [
    item.option_a,
    item.option_b,
    item.option_c,
    item.option_d
  ];

  options.forEach((op, i) => {
    const b = document.createElement("button");
    b.className = "option";
    b.textContent = `${String.fromCharCode(65 + i)}. ${op}`;

    b.onclick = () => {
      selected = i;
      [...box.children].forEach(x => x.classList.remove("selected"));
      b.classList.add("selected");
    };

    box.appendChild(b);
  });
}

async function nextQuestion() {
  if (selected === null) {
    alert("Please select an answer.");
    return;
  }

  const item = currentQuestions[currentIndex];

  const correct =
    String.fromCharCode(65 + selected) ===
      String(item.correct_answer).toUpperCase()
    || String(selected) === String(item.correct_answer);

  if (correct) score++;

  currentIndex++;

  if (currentIndex >= currentQuestions.length) {
    clearInterval(timer);
    await showResult();
    return;
  }

  renderQuestion();
}

function startTimer() {
  clearInterval(timer);

  document.getElementById("timer").textContent = "10:00";

  timer = setInterval(() => {
    seconds--;

    const m = Math.floor(seconds / 60);
    const s = String(seconds % 60).padStart(2, "0");

    document.getElementById("timer").textContent = `${m}:${s}`;

    if (seconds <= 0) {
      clearInterval(timer);
      showResult();
    }
  }, 1000);
}

async function showResult() {
  show("result");

  const total = currentQuestions.length;
  const percent = total
    ? Math.round(score / total * 100)
    : 0;

  document.getElementById("score").textContent =
    `You scored ${score}/${total} (${percent}%).`;

  if (activeStudent && currentSubject) {
    try {
      await api("submit-result", {
        student_id: activeStudent.id,
        subject_id: currentSubject.id,
        score,
        total_questions: total
      });
    } catch {}
  }
}

function logout() {
  clearInterval(timer);
  activeStudent = null;
  sessionStorage.removeItem("waec_active");
  showHome();
}

function openWhatsApp() {
  window.open(
    "https://chat.whatsapp.com/REPLACE_WITH_YOUR_LINK",
    "_blank"
  );
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[ch]));
}

loadActive();

if (!verifyCallback()) {
  if (activeStudent) showSubjects();
  else showHome();
}
