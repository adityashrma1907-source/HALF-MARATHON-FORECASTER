const fileInput = document.getElementById("csvFile");
const analyzeButton = document.getElementById("analyzeButton");
const useManualButton = document.getElementById("useManualButton");
const manualForm = document.getElementById("manualForm");
const runDateInput = document.getElementById("runDate");
const runDistanceInput = document.getElementById("runDistance");
const runTimeInput = document.getElementById("runTime");
const bulkRunsInput = document.getElementById("bulkRuns");
const clearRunsButton = document.getElementById("clearRunsButton");
const manualRunsBody = document.getElementById("manualRunsBody");
const manualRunsEmpty = document.getElementById("manualRunsEmpty");
const forecastModeInput = document.getElementById("forecastMode");
const goalDateInput = document.getElementById("goalDate");
const statusText = document.getElementById("status");
const resultsSection = document.getElementById("results");
const authForm = document.getElementById("authForm");
const emailInput = document.getElementById("emailInput");
const passwordInput = document.getElementById("passwordInput");
const registerButton = document.getElementById("registerButton");
const loginButton = document.getElementById("loginButton");
const logoutButton = document.getElementById("logoutButton");
const accountStatus = document.getElementById("accountStatus");

const manualRuns = [];
const LOCAL_STATE_KEY = "strava-half-forecaster-state-v2";
const SESSION_KEY = "strava-half-forecaster-session-v1";
const authState = {
  token: null,
  email: null,
};

analyzeButton.addEventListener("click", async () => {
  const file = fileInput.files?.[0];
  if (!file) {
    setStatus("Choose a Strava CSV file first.");
    return;
  }

  try {
    setStatus("Reading your activity history...");
    const text = await file.text();
    const rows = parseCsv(text);
    const activities = mapRowsToActivities(rows);

    if (!activities.length) {
      throw new Error("No rows could be parsed from the CSV.");
    }

    runAnalysis(activities, `Analyzed ${activities.length} runs from your Strava export.`);
  } catch (error) {
    handleAnalysisError(error, "Something went wrong while reading the file.");
  }
});

manualForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const date = runDateInput.value;
  const distanceKm = Number.parseFloat(runDistanceInput.value);
  const movingSeconds = parseDurationToSeconds(runTimeInput.value);

  if (!date || !Number.isFinite(distanceKm) || distanceKm <= 0 || !movingSeconds) {
    setStatus("Enter a valid date, distance, and time before adding a run.");
    return;
  }

  manualRuns.push(createManualRun(date, distanceKm, movingSeconds));
  sortManualRuns();
  renderManualRuns();
  await saveAppState();
  manualForm.reset();
  runDateInput.value = formatInputDate(new Date());
  setStatus(`Added run on ${date}.`);
});

useManualButton.addEventListener("click", () => {
  try {
    const combinedRuns = buildCombinedManualRuns();
    if (!combinedRuns.length) {
      throw new Error("Type at least a few runs before analyzing.");
    }

    runAnalysis(combinedRuns, `Analyzed ${combinedRuns.length} manually entered runs.`);
  } catch (error) {
    handleAnalysisError(error, "Could not analyze the typed data.");
  }
});

clearRunsButton.addEventListener("click", async () => {
  manualRuns.length = 0;
  bulkRunsInput.value = "";
  renderManualRuns();
  await saveAppState();
  resultsSection.classList.add("hidden");
  setStatus("Cleared typed runs.");
});

manualRunsBody.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-index]");
  if (!button) {
    return;
  }

  const index = Number(button.dataset.index);
  manualRuns.splice(index, 1);
  renderManualRuns();
  await saveAppState();
  setStatus("Removed run.");
});

registerButton.addEventListener("click", () => handleAuth("register"));
loginButton.addEventListener("click", () => handleAuth("login"));
logoutButton.addEventListener("click", handleLogout);

forecastModeInput.addEventListener("change", () => void saveAppState());
goalDateInput.addEventListener("change", () => void saveAppState());
bulkRunsInput.addEventListener("input", () => void saveAppState());
authForm.addEventListener("submit", (event) => event.preventDefault());

initializeApp();

async function initializeApp() {
  loadLocalState();
  if (!runDateInput.value) {
    runDateInput.value = formatInputDate(new Date());
  }
  if (!goalDateInput.value) {
    goalDateInput.value = formatInputDate(addDays(new Date(), 84));
  }
  renderManualRuns();
  updateAccountUI();
  await restoreSessionAndSync();
}

async function restoreSessionAndSync() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) {
      return;
    }

    const session = JSON.parse(raw);
    if (!session?.token || !session?.email) {
      return;
    }

    authState.token = session.token;
    authState.email = session.email;
    updateAccountUI();
    await syncFromCloud();
    setStatus(`Signed in as ${authState.email}.`);
  } catch (error) {
    console.error(error);
    clearSession();
    updateAccountUI();
  }
}

async function handleAuth(mode) {
  const email = emailInput.value.trim().toLowerCase();
  const password = passwordInput.value;

  if (!email || !password) {
    setStatus("Enter your email and password first.");
    return;
  }

  try {
    setStatus(mode === "register" ? "Creating your account..." : "Signing you in...");
    const payload = await apiFetch(`/api/auth/${mode}`, {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });

    authState.token = payload.sessionToken;
    authState.email = payload.email;
    persistSession();
    updateAccountUI();
    passwordInput.value = "";
    await syncFromCloud();
    setStatus(mode === "register" ? "Account created and synced." : "Signed in and synced.");
  } catch (error) {
    console.error(error);
    setStatus(error.message || "Could not sign you in.");
  }
}

async function handleLogout() {
  authState.token = null;
  authState.email = null;
  clearSession();
  updateAccountUI();
  setStatus("Signed out. Local copy is still available on this device.");
}

function persistSession() {
  localStorage.setItem(
    SESSION_KEY,
    JSON.stringify({
      token: authState.token,
      email: authState.email,
    }),
  );
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

function updateAccountUI() {
  const signedIn = Boolean(authState.token);
  accountStatus.textContent = signedIn ? `Signed in as ${authState.email}` : "Not signed in";
  logoutButton.style.display = signedIn ? "inline-flex" : "none";
}

async function syncFromCloud() {
  if (!authState.token) {
    return;
  }

  const remoteState = await apiFetch("/api/state");
  const localState = getCurrentState();
  const hasRemoteData = hasAnyData(remoteState);
  const hasLocalData = hasAnyData(localState);

  if (hasRemoteData) {
    applyState(remoteState);
    setStatus("Loaded your saved data from the cloud.");
    return;
  }

  if (hasLocalData) {
    await pushStateToCloud(localState);
    setStatus("Moved your current device data into your account.");
  }
}

async function saveAppState() {
  const state = getCurrentState();
  localStorage.setItem(LOCAL_STATE_KEY, JSON.stringify(state));

  if (!authState.token) {
    return;
  }

  try {
    await pushStateToCloud(state);
  } catch (error) {
    console.error(error);
    setStatus("Saved on this device, but cloud sync failed for now.");
  }
}

function loadLocalState() {
  try {
    const raw = localStorage.getItem(LOCAL_STATE_KEY);
    if (!raw) {
      return;
    }

    applyState(JSON.parse(raw));
  } catch (error) {
    console.error("Failed to load local state", error);
  }
}

function getCurrentState() {
  return {
    manualRuns: manualRuns.map((run) => ({
      date: formatInputDate(run.date),
      distanceKm: run.distanceKm,
      movingSeconds: run.movingSeconds,
    })),
    bulkRuns: bulkRunsInput.value,
    forecastMode: forecastModeInput.value,
    goalDate: goalDateInput.value,
  };
}

function applyState(state) {
  manualRuns.length = 0;

  for (const run of state?.manualRuns || []) {
    if (!run.date || !Number.isFinite(run.distanceKm) || !run.movingSeconds) {
      continue;
    }
    manualRuns.push(createManualRun(run.date, run.distanceKm, run.movingSeconds));
  }

  bulkRunsInput.value = state?.bulkRuns || "";
  forecastModeInput.value = state?.forecastMode || "comfort";
  goalDateInput.value = state?.goalDate || "";
  renderManualRuns();
}

function hasAnyData(state) {
  return Boolean(state?.manualRuns?.length || state?.bulkRuns?.trim());
}

async function pushStateToCloud(state) {
  await apiFetch("/api/state", {
    method: "PUT",
    body: JSON.stringify(state),
  });
}

async function apiFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(authState.token ? { Authorization: `Bearer ${authState.token}` } : {}),
      ...(options.headers || {}),
    },
  });

  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : { error: await response.text() };

  if (!response.ok) {
    if (response.status === 401) {
      clearSession();
      authState.token = null;
      authState.email = null;
      updateAccountUI();
    }
    throw new Error(payload.error || "Request failed.");
  }

  return payload;
}

function runAnalysis(activities, successMessage) {
  setStatus("Calculating running readiness...");
  const analysis = analyzeActivities(activities, {
    mode: forecastModeInput.value,
    goalDate: goalDateInput.value ? parseDate(goalDateInput.value) : null,
  });
  renderAnalysis(analysis);
  resultsSection.classList.remove("hidden");
  setStatus(successMessage);
}

function handleAnalysisError(error, fallback) {
  console.error(error);
  resultsSection.classList.add("hidden");
  setStatus(error.message || fallback);
}

function setStatus(message) {
  statusText.textContent = message;
}

function createManualRun(date, distanceKm, movingSeconds) {
  return {
    title: "Manual run",
    type: "run",
    date: parseDate(date),
    distanceKm,
    movingSeconds,
  };
}

function buildCombinedManualRuns() {
  return dedupeRuns([...manualRuns, ...parseBulkRuns(bulkRunsInput.value)]);
}

function dedupeRuns(runs) {
  const seen = new Set();
  return runs.filter((run) => {
    const key = `${formatInputDate(run.date)}-${round1(run.distanceKm)}-${run.movingSeconds}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function parseBulkRuns(text) {
  if (!text.trim()) {
    return [];
  }

  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const parts = line.split(",").map((part) => part.trim());
      if (parts.length < 3) {
        throw new Error(`Line ${index + 1} should look like YYYY-MM-DD, distance, time.`);
      }

      const [date, distanceValue, timeValue] = parts;
      const distanceKm = Number.parseFloat(distanceValue);
      const movingSeconds = parseDurationToSeconds(timeValue);

      if (!parseDate(date) || !Number.isFinite(distanceKm) || distanceKm <= 0 || !movingSeconds) {
        throw new Error(`Line ${index + 1} has invalid data.`);
      }

      return createManualRun(date, distanceKm, movingSeconds);
    });
}

function renderManualRuns() {
  sortManualRuns();
  manualRunsBody.innerHTML = manualRuns
    .map(
      (run, index) => `
        <tr>
          <td>${formatDate(run.date)}</td>
          <td>${formatKm(run.distanceKm)}</td>
          <td>${formatDuration(run.movingSeconds)}</td>
          <td><button type="button" class="secondary-button" data-index="${index}">Remove</button></td>
        </tr>
      `,
    )
    .join("");

  manualRunsEmpty.style.display = manualRuns.length ? "none" : "block";
}

function sortManualRuns() {
  manualRuns.sort((a, b) => a.date - b.date);
}

function parseCsv(text) {
  const rows = [];
  let current = "";
  let row = [];
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(current);
      current = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      row.push(current);
      if (row.some((cell) => cell.trim() !== "")) {
        rows.push(row);
      }
      row = [];
      current = "";
      continue;
    }

    current += char;
  }

  if (current.length || row.length) {
    row.push(current);
    rows.push(row);
  }

  const headers = rows.shift()?.map((header) => header.trim()) || [];
  return rows.map((cells) =>
    Object.fromEntries(headers.map((header, index) => [header, (cells[index] || "").trim()])),
  );
}

function mapRowsToActivities(rows) {
  return rows
    .map((row) => {
      const type = readField(row, ["Activity Type", "Type", "Sport Type"]);
      const dateValue = readField(row, ["Activity Date", "Date", "Start Date"]);
      const distanceValue = readField(row, ["Distance", "Distance.1"]);
      const movingTimeValue = readField(row, ["Moving Time", "Elapsed Time", "Duration"]);
      const paceValue = readField(row, ["Average Pace", "Avg Pace"]);
      const title = readField(row, ["Activity Name", "Title", "Name"]);

      const date = parseDate(dateValue);
      const distanceKm = parseDistanceToKm(distanceValue);
      const movingSeconds =
        parseDurationToSeconds(movingTimeValue) ||
        inferSecondsFromPace(distanceKm, paceValue);

      return {
        title: title || "Untitled activity",
        type: (type || "").toLowerCase(),
        date,
        distanceKm,
        movingSeconds,
      };
    })
    .filter(
      (activity) =>
        activity.date instanceof Date &&
        !Number.isNaN(activity.date.valueOf()) &&
        Number.isFinite(activity.distanceKm) &&
        activity.distanceKm > 0 &&
        activity.type.includes("run"),
    )
    .sort((a, b) => a.date - b.date);
}

function readField(row, candidates) {
  for (const key of candidates) {
    if (row[key]) {
      return row[key];
    }
  }
  return "";
}

function parseDate(value) {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date;
}

function parseDistanceToKm(value) {
  if (!value) {
    return NaN;
  }

  const cleaned = value.replace(/,/g, "").trim().toLowerCase();
  const numeric = Number.parseFloat(cleaned);
  if (!Number.isFinite(numeric)) {
    return NaN;
  }

  if (cleaned.includes("mi")) {
    return numeric * 1.60934;
  }
  if (cleaned.includes("m") && !cleaned.includes("km")) {
    return numeric / 1000;
  }

  return numeric;
}

function parseDurationToSeconds(value) {
  if (!value) {
    return null;
  }

  if (/^\d+:\d{1,2}:\d{1,2}$/.test(value)) {
    const [hours, minutes, seconds] = value.split(":").map(Number);
    return hours * 3600 + minutes * 60 + seconds;
  }

  if (/^\d+:\d{1,2}$/.test(value)) {
    const [minutes, seconds] = value.split(":").map(Number);
    return minutes * 60 + seconds;
  }

  const tokens = value.toLowerCase();
  const hours = extractUnit(tokens, /(\d+(?:\.\d+)?)\s*h/);
  const minutes = extractUnit(tokens, /(\d+(?:\.\d+)?)\s*m(?!i)/);
  const seconds = extractUnit(tokens, /(\d+(?:\.\d+)?)\s*s/);
  const total = hours * 3600 + minutes * 60 + seconds;
  return total > 0 ? total : null;
}

function inferSecondsFromPace(distanceKm, paceValue) {
  if (!distanceKm || !paceValue) {
    return null;
  }
  const secondsPerKm = parsePaceToSecondsPerKm(paceValue);
  return secondsPerKm ? Math.round(distanceKm * secondsPerKm) : null;
}

function parsePaceToSecondsPerKm(value) {
  if (!value) {
    return null;
  }

  const cleaned = value.trim().toLowerCase();
  const match = cleaned.match(/(\d+):(\d{2})/);
  if (!match) {
    return null;
  }

  let seconds = Number(match[1]) * 60 + Number(match[2]);
  if (cleaned.includes("/mi")) {
    seconds /= 1.60934;
  }
  return seconds;
}

function extractUnit(text, pattern) {
  const match = text.match(pattern);
  return match ? Number.parseFloat(match[1]) : 0;
}

function analyzeActivities(activities, options) {
  const today = startOfDay(new Date());
  const recent12Weeks = activities.filter((run) => daysBetween(run.date, today) <= 84);
  const recent8Weeks = activities.filter((run) => daysBetween(run.date, today) <= 56);
  const recent6Weeks = activities.filter((run) => daysBetween(run.date, today) <= 42);

  if (!recent12Weeks.length) {
    throw new Error("No runs found in the last 12 weeks. Add fresher runs to forecast 21K readiness.");
  }

  const weeklyBuckets = bucketRunsByWeek(recent12Weeks);
  const weeklyVolumes = weeklyBuckets.map((week) => week.totalKm);
  const avgWeeklyKm = average(weeklyVolumes);
  const consistencyRatio =
    weeklyBuckets.filter((week) => week.totalKm >= Math.max(5, avgWeeklyKm * 0.55)).length /
    weeklyBuckets.length;
  const missedWeeks = weeklyBuckets.filter((week) => week.totalKm < 4).length;
  const recentLongRuns = [...recent8Weeks].sort((a, b) => b.distanceKm - a.distanceKm);
  const bestLongRun = recentLongRuns[0] || null;
  const comfortableLongRunKm = Math.max(
    0,
    Math.min(
      bestLongRun ? bestLongRun.distanceKm * 0.82 : 0,
      percentile(recent8Weeks.map((run) => run.distanceKm), 0.8) || 0,
    ),
  );
  const averagePaceSecPerKm = average(
    recent6Weeks
      .filter((run) => run.movingSeconds && run.distanceKm >= 3)
      .map((run) => run.movingSeconds / run.distanceKm),
  );
  const paceTrendSeconds = getPaceTrendSeconds(recent6Weeks);
  const mode = options.mode === "race" ? "race" : "comfort";
  const targetConfig = getTargetConfig(mode);
  const readinessScore = getReadinessScore({
    consistencyRatio,
    comfortableLongRunKm,
    avgWeeklyKm,
    paceTrendSeconds,
    missedWeeks,
    mode,
  });
  const readinessLabel = getReadinessLabel(readinessScore, mode);
  const requiredLongRunKm = targetConfig.longRunKm;
  const requiredWeeklyKm = targetConfig.weeklyKm;
  const currentLongRunGap = Math.max(0, requiredLongRunKm - comfortableLongRunKm);
  const currentVolumeGap = Math.max(0, requiredWeeklyKm - avgWeeklyKm);
  const longRunGainPerWeek = Math.max(0.8, Math.min(2, comfortableLongRunKm * 0.09 || 0.8));
  const weeklyVolumeGain = Math.max(2, Math.min(6, avgWeeklyKm * 0.1 || 2));
  const weeksForLongRun = Math.ceil(currentLongRunGap / longRunGainPerWeek);
  const weeksForVolume = Math.ceil(currentVolumeGap / weeklyVolumeGain);
  const consistencyPenalty = consistencyRatio >= 0.75 ? 0 : consistencyRatio >= 0.5 ? 1 : 2;
  const missedWeekPenalty = Math.min(2, missedWeeks);
  const pacePenalty = paceTrendSeconds <= -8 ? -1 : paceTrendSeconds >= 10 ? 1 : 0;
  const baseWeeks =
    Math.max(weeksForLongRun, weeksForVolume, 1) + consistencyPenalty + missedWeekPenalty + pacePenalty;
  const forecastDate = addDays(today, baseWeeks * 7);
  const confidence = getConfidenceLabel({
    consistencyRatio,
    comfortableLongRunKm,
    avgWeeklyKm,
    readinessScore,
  });
  const goalAssessment = assessGoalDate({
    goalDate: options.goalDate,
    today,
    forecastDate,
    readinessScore,
    mode,
  });

  return {
    mode,
    runCount: activities.length,
    forecastDate,
    confidence,
    readinessScore,
    readinessLabel,
    comfortableLongRunKm,
    averagePaceSecPerKm,
    avgWeeklyKm,
    bestLongRun,
    consistencyRatio,
    goalAssessment,
    weeklyTargets: buildWeeklyTargets({
      today,
      avgWeeklyKm,
      comfortableLongRunKm,
      averagePaceSecPerKm,
      paceTrendSeconds,
      readinessScore,
      mode,
    }),
    insights: buildInsights({
      avgWeeklyKm,
      consistencyRatio,
      comfortableLongRunKm,
      bestLongRun,
      forecastDate,
      baseWeeks,
      paceTrendSeconds,
      mode,
    }),
    notes: buildNotes({
      recent12Weeks,
      recent8Weeks,
      avgWeeklyKm,
      comfortableLongRunKm,
      mode,
      goalDate: options.goalDate,
    }),
    charts: buildChartSeries(weeklyBuckets),
  };
}

function getTargetConfig(mode) {
  return mode === "race"
    ? { longRunKm: 19, weeklyKm: 34 }
    : { longRunKm: 18, weeklyKm: 28 };
}

function getReadinessScore({
  consistencyRatio,
  comfortableLongRunKm,
  avgWeeklyKm,
  paceTrendSeconds,
  missedWeeks,
  mode,
}) {
  const target = getTargetConfig(mode);
  const longRunScore = clamp((comfortableLongRunKm / target.longRunKm) * 38, 0, 38);
  const volumeScore = clamp((avgWeeklyKm / target.weeklyKm) * 30, 0, 30);
  const consistencyScore = clamp(consistencyRatio * 22, 0, 22);
  const trendScore =
    paceTrendSeconds <= -10 ? 10 : paceTrendSeconds <= -3 ? 7 : paceTrendSeconds < 8 ? 5 : 2;
  const missedPenalty = missedWeeks * 3;
  return Math.max(
    1,
    Math.min(100, Math.round(longRunScore + volumeScore + consistencyScore + trendScore - missedPenalty)),
  );
}

function getReadinessLabel(score, mode) {
  if (score >= 80) {
    return mode === "race" ? "Strong race-readiness signal." : "Strong comfort-readiness signal.";
  }
  if (score >= 60) {
    return mode === "race" ? "Close, but needs a few sharper weeks." : "Good base, a few durable weeks away.";
  }
  if (score >= 40) {
    return "Foundation is building, but the half marathon is not quite comfortable yet.";
  }
  return "Early build phase. Focus on consistency first.";
}

function assessGoalDate({ goalDate, today, forecastDate, readinessScore, mode }) {
  if (!goalDate) {
    return "Add a goal date above to see whether your current training trend gets you there in time.";
  }

  const targetDate = startOfDay(goalDate);
  const weeksToGoal = Math.max(0, Math.ceil(daysBetween(today, targetDate) / 7));
  const weeksToForecast = Math.ceil(daysBetween(today, forecastDate) / 7);

  if (targetDate < today) {
    return "That goal date is already in the past, so choose a future date to compare against your forecast.";
  }

  if (targetDate >= forecastDate) {
    return `${mode === "race" ? "Race-ready" : "Comfortable"} 21K by ${formatDate(targetDate)} looks realistic. You have about ${weeksToGoal} week${weeksToGoal === 1 ? "" : "s"} and your current forecast lands on ${formatDate(forecastDate)}.`;
  }

  const gap = Math.max(1, weeksToForecast - weeksToGoal);
  return `${formatDate(targetDate)} looks ambitious right now. You are roughly ${gap} week${gap === 1 ? "" : "s"} short of the current ${mode === "race" ? "race-ready" : "comfort"} forecast, and your readiness score is ${readinessScore}/100.`;
}

function buildWeeklyTargets({
  today,
  avgWeeklyKm,
  comfortableLongRunKm,
  averagePaceSecPerKm,
  paceTrendSeconds,
  readinessScore,
  mode,
}) {
  const targets = [];
  let currentWeeklyKm = Math.max(avgWeeklyKm, 10);
  let currentLongRunKm = Math.max(comfortableLongRunKm, 6);
  const target = getTargetConfig(mode);
  const weeklyCap = target.weeklyKm + (mode === "race" ? 6 : 4);
  const longRunCap = mode === "race" ? 21 : 20;

  for (let index = 0; index < 4; index += 1) {
    const isCutback = index === 3;
    const safeRamp = currentWeeklyKm < 18 ? 2 : Math.max(2, currentWeeklyKm * 0.08);
    const aggressivePenalty = readinessScore < 45 ? 0.85 : 1;
    currentWeeklyKm = isCutback
      ? Math.max(12, currentWeeklyKm * 0.86)
      : Math.min(weeklyCap, currentWeeklyKm + safeRamp * aggressivePenalty);
    currentLongRunKm = isCutback
      ? Math.max(8, currentLongRunKm - 1.5)
      : Math.min(
          longRunCap,
          currentLongRunKm + (currentLongRunKm >= 15 ? 1 : 1.5) * aggressivePenalty,
        );

    targets.push({
      weekLabel: formatWeekRange(addDays(today, index * 7)),
      weeklyKm: round1(currentWeeklyKm),
      longRunKm: round1(currentLongRunKm),
      focus: buildFocusLabel({
        longRunKm: currentLongRunKm,
        averagePaceSecPerKm,
        paceTrendSeconds,
        isCutback,
        mode,
      }),
    });
  }

  return targets;
}

function buildFocusLabel({ longRunKm, averagePaceSecPerKm, paceTrendSeconds, isCutback, mode }) {
  if (isCutback) {
    return "Cutback week: keep it light, absorb the training, and arrive fresh.";
  }
  if (longRunKm < 12) {
    return "Easy effort, relaxed breathing, and smooth recovery the next day.";
  }
  if (mode === "race" && longRunKm >= 16) {
    return `Finish the last 3 km with control around ${formatPace((averagePaceSecPerKm || 360) - 8)} /km if it feels natural.`;
  }
  if (paceTrendSeconds <= -8) {
    return "Your pace trend is improving, so keep most of the week easy and let the long run do the work.";
  }
  return `Stay conversational for most of the run, around ${formatPace((averagePaceSecPerKm || 375) + 15)} /km.`;
}

function buildInsights({
  avgWeeklyKm,
  consistencyRatio,
  comfortableLongRunKm,
  bestLongRun,
  forecastDate,
  baseWeeks,
  paceTrendSeconds,
  mode,
}) {
  const insights = [
    `Recent average volume is ${formatKm(avgWeeklyKm)} per week.`,
    `${mode === "race" ? "Race-readiness" : "Comfort"} mode is active, so the forecast thresholds are tuned accordingly.`,
    `Your comfortable long-run estimate is ${formatKm(comfortableLongRunKm)}, which is more conservative than a one-off peak run.`,
    `Consistency across the last 12 weeks is ${Math.round(consistencyRatio * 100)}%.`,
    `At your current trend, a ${mode === "race" ? "race-ready" : "comfortable"} 21K looks realistic in about ${baseWeeks} week${baseWeeks === 1 ? "" : "s"}, landing around ${formatDate(forecastDate)}.`,
  ];

  if (bestLongRun) {
    insights.splice(
      3,
      0,
      `Your strongest recent long run was ${formatKm(bestLongRun.distanceKm)} on ${formatDate(bestLongRun.date)}.`,
    );
  }

  if (paceTrendSeconds <= -8) {
    insights.push("Your recent pace trend is improving, which helps bring the forecast closer.");
  } else if (paceTrendSeconds >= 10) {
    insights.push("Recent pace has drifted slower, so the forecast adds a small caution penalty.");
  }

  return insights;
}

function buildNotes({ recent12Weeks, recent8Weeks, avgWeeklyKm, comfortableLongRunKm, mode, goalDate }) {
  const notes = [
    "This model uses only the last 12 weeks so it reflects current fitness more than old peak form.",
    '"Comfortable" means enough long-run durability plus enough weekly volume, not just surviving one 21K attempt.',
    "The 4-week planner includes a cutback week to reduce the chance of overreaching.",
  ];

  if (mode === "race") {
    notes.push("Race mode asks for slightly higher weekly volume and long-run durability than comfort mode.");
  }
  if (recent8Weeks.length < 6) {
    notes.push("There are relatively few runs in the last 8 weeks, so the forecast is more fragile than usual.");
  }
  if (avgWeeklyKm < 20 || comfortableLongRunKm < 12) {
    notes.push("Right now the forecast depends more on safe progression assumptions than strong half-marathon-specific evidence.");
  }
  if (recent12Weeks.length < 10) {
    notes.push("Limited recent data means the weekly targets should be treated as starter guidance, not a rigid plan.");
  }
  if (goalDate) {
    notes.push("Goal-date assessment is based on the current trend, not guaranteed race-day performance.");
  }

  return notes;
}

function buildChartSeries(weeklyBuckets) {
  return weeklyBuckets.map((week) => ({
    label: formatShortWeek(week.startDate),
    volumeKm: round1(week.totalKm),
    longRunKm: round1(week.longRunKm),
  }));
}

function bucketRunsByWeek(runs) {
  const buckets = new Map();

  for (const run of runs) {
    const startDate = getWeekStart(run.date);
    const key = startDate.toISOString().slice(0, 10);
    const bucket = buckets.get(key) || { startDate, totalKm: 0, runs: 0, longRunKm: 0 };
    bucket.totalKm += run.distanceKm;
    bucket.runs += 1;
    bucket.longRunKm = Math.max(bucket.longRunKm, run.distanceKm);
    buckets.set(key, bucket);
  }

  return [...buckets.values()].sort((a, b) => a.startDate - b.startDate);
}

function getWeekStart(date) {
  const copy = new Date(date);
  const day = copy.getDay();
  const diff = copy.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(copy.getFullYear(), copy.getMonth(), diff);
}

function getPaceTrendSeconds(runs) {
  const eligible = runs
    .filter((run) => run.movingSeconds && run.distanceKm >= 4)
    .sort((a, b) => a.date - b.date);
  if (eligible.length < 4) {
    return 0;
  }

  const midpoint = Math.floor(eligible.length / 2);
  const firstHalf = average(
    eligible.slice(0, midpoint).map((run) => run.movingSeconds / run.distanceKm),
  );
  const secondHalf = average(
    eligible.slice(midpoint).map((run) => run.movingSeconds / run.distanceKm),
  );
  return round1(secondHalf - firstHalf);
}

function renderAnalysis(analysis) {
  document.getElementById("forecastHeading").textContent =
    analysis.mode === "race" ? "Race-ready 21K forecast" : "Comfortable 21K forecast";
  document.getElementById("forecastDate").textContent = formatDate(analysis.forecastDate);
  document.getElementById("forecastConfidence").textContent = analysis.confidence;
  document.getElementById("readinessScore").textContent = `${analysis.readinessScore}/100`;
  document.getElementById("readinessLabel").textContent = analysis.readinessLabel;
  document.getElementById("comfortDistance").textContent = formatKm(analysis.comfortableLongRunKm);
  document.getElementById("comfortPace").textContent = analysis.averagePaceSecPerKm
    ? `Typical pace around ${formatPace(analysis.averagePaceSecPerKm)} /km`
    : "Pace unavailable from data";
  document.getElementById("weeklyVolume").textContent = `${formatKm(analysis.avgWeeklyKm)} / week`;
  document.getElementById("consistency").textContent = `${Math.round(analysis.consistencyRatio * 100)}% consistent weeks`;
  document.getElementById("bestLongRun").textContent = analysis.bestLongRun
    ? formatKm(analysis.bestLongRun.distanceKm)
    : "-";
  document.getElementById("bestLongRunPace").textContent =
    analysis.bestLongRun?.movingSeconds && analysis.bestLongRun?.distanceKm
      ? `${formatPace(analysis.bestLongRun.movingSeconds / analysis.bestLongRun.distanceKm)} /km`
      : "Pace unavailable";
  document.getElementById("goalDateSummary").textContent = analysis.goalAssessment;

  const targetsBody = document.getElementById("targetsBody");
  targetsBody.innerHTML = analysis.weeklyTargets
    .map(
      (target) => `
        <tr>
          <td>${target.weekLabel}</td>
          <td>${formatKm(target.weeklyKm)}</td>
          <td>${formatKm(target.longRunKm)}</td>
          <td>${target.focus}</td>
        </tr>
      `,
    )
    .join("");

  renderChart("volumeChart", analysis.charts, "volumeKm", "");
  renderChart("longRunChart", analysis.charts, "longRunKm", "green");
  renderList("insightsList", analysis.insights);
  renderList("notesList", analysis.notes);
}

function renderChart(id, rows, key, variant) {
  const container = document.getElementById(id);
  const max = Math.max(...rows.map((row) => row[key]), 1);
  container.innerHTML = rows
    .map(
      (row) => `
        <div class="bar-row">
          <span>${row.label}</span>
          <div class="bar-track">
            <div class="bar-fill ${variant}" style="width: ${(row[key] / max) * 100}%"></div>
          </div>
          <strong>${row[key]} km</strong>
        </div>
      `,
    )
    .join("");
}

function renderList(id, items) {
  document.getElementById(id).innerHTML = items.map((item) => `<li>${item}</li>`).join("");
}

function average(values) {
  if (!values.length) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values, p) {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
  return sorted[index];
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date, days) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function daysBetween(a, b) {
  return Math.abs(startOfDay(b) - startOfDay(a)) / (1000 * 60 * 60 * 24);
}

function formatDate(date) {
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

function formatShortWeek(date) {
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
  }).format(date);
}

function formatWeekRange(date) {
  const end = addDays(date, 6);
  return `${formatDate(date)} - ${formatDate(end)}`;
}

function formatKm(value) {
  return `${round1(value)} km`;
}

function formatPace(secondsPerKm) {
  if (!secondsPerKm || !Number.isFinite(secondsPerKm) || secondsPerKm <= 0) {
    return "-";
  }
  const totalSeconds = Math.round(secondsPerKm);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function formatDuration(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}

function formatInputDate(date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function getConfidenceLabel({ consistencyRatio, comfortableLongRunKm, avgWeeklyKm, readinessScore }) {
  const score =
    (consistencyRatio >= 0.75 ? 2 : consistencyRatio >= 0.5 ? 1 : 0) +
    (comfortableLongRunKm >= 14 ? 2 : comfortableLongRunKm >= 10 ? 1 : 0) +
    (avgWeeklyKm >= 30 ? 2 : avgWeeklyKm >= 20 ? 1 : 0) +
    (readinessScore >= 70 ? 2 : readinessScore >= 50 ? 1 : 0);

  if (score >= 6) {
    return "High confidence: recent data is lining up well.";
  }
  if (score >= 4) {
    return "Medium confidence: the direction is good, but consistency still matters.";
  }
  return "Low-to-medium confidence: this forecast depends on staying regular and building gradually.";
}
