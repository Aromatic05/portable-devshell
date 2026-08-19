// Keep this resource identity stable across Workspace markup/runtime upgrades. Mounted hosts may
// cache the URI from an older tool snapshot and read it again after the server has upgraded.
export const workspaceAppResourceUri = "ui://portable-devshell/workspace/v1.html";

export const workspaceAppHtml = String.raw`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; padding: 12px; background: transparent; color: CanvasText; }
header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
h1 { font-size: 15px; margin: 0; font-weight: 650; }
small, .muted { color: color-mix(in srgb, CanvasText 58%, transparent); font-size: 11px; }
.grid { display: grid; gap: 8px; }
.card { border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 10px; padding: 10px; background: color-mix(in srgb, Canvas 92%, CanvasText 8%); }
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.row.between { justify-content: space-between; }
.title { font-size: 13px; font-weight: 650; }
.question { margin: 6px 0 8px; font-size: 13px; line-height: 1.35; }
button, input { font: inherit; }
button { border: 1px solid color-mix(in srgb, CanvasText 24%, transparent); border-radius: 8px; padding: 5px 9px; background: Canvas; color: CanvasText; cursor: pointer; }
button.primary { font-weight: 650; }
button.danger { color: #c43b3b; }
button:disabled { opacity: .55; cursor: default; }
input { flex: 1 1 180px; min-width: 0; border: 1px solid color-mix(in srgb, CanvasText 24%, transparent); border-radius: 8px; padding: 6px 8px; background: Canvas; color: CanvasText; }
.badge { border-radius: 999px; padding: 2px 7px; font-size: 10px; background: color-mix(in srgb, CanvasText 10%, transparent); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
.empty { padding: 14px 8px; text-align: center; font-size: 12px; color: color-mix(in srgb, CanvasText 55%, transparent); }
.section-head { margin: 8px 2px 5px; font-size: 11px; font-weight: 650; text-transform: uppercase; letter-spacing: .04em; color: color-mix(in srgb, CanvasText 58%, transparent); }
</style>
</head>
<body>
<header><h1>portable-devshell</h1><small id="status">Connecting…</small></header>
<div id="root" class="grid"><div class="empty">Waiting for Workspace state…</div></div>
<script>
(function () {
  var root = document.getElementById("root");
  var status = document.getElementById("status");
  var pending = new Map();
  var nextId = 1;
  var ctxId = "";
  var appToken = "";
  var initialized = false;
  var snapshot = null;
  var cursor = 0;
  var watchGeneration = 0;
  var recovering = false;
  var busy = new Set();

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  }

  function request(method, params) {
    var id = nextId++;
    window.parent.postMessage({ jsonrpc: "2.0", id: id, method: method, params: params }, "*");
    return new Promise(function (resolve, reject) { pending.set(id, { resolve: resolve, reject: reject }); });
  }

  function notify(method, params) {
    window.parent.postMessage({ jsonrpc: "2.0", method: method, params: params || {} }, "*");
  }

  function callTool(name, args, requiresToken) {
    if (!initialized) return Promise.reject(new Error("Workspace App is not initialized"));
    if (requiresToken && !appToken) return Promise.reject(new Error("Workspace App authorization is unavailable"));
    var input = Object.assign({ ctxId: ctxId }, args || {});
    if (requiresToken) input.token = appToken;
    return request("tools/call", { name: name, arguments: input }).then(function (result) {
      acceptMeta(result && result._meta);
      return result;
    });
  }

  function structured(result) {
    return result && result.structuredContent ? result.structuredContent : result;
  }

  function acceptMeta(meta) {
    var hidden = meta && meta["portable-devshell/workspace"];
    if (hidden && hidden.token) appToken = String(hidden.token);
  }

  function modelContext(extra) {
    var tasks = snapshot && Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
    var background = snapshot && Array.isArray(snapshot.background) ? snapshot.background : [];
    var state = {
      ctxId: ctxId,
      instance: snapshot && snapshot.instance,
      tasks: tasks.map(function (task) { return {
        taskId: task.taskId,
        title: task.title,
        status: task.status,
        currentItem: task.currentItem,
        checkpoint: task.checkpoint
      }; }),
      background: background.map(function (item) { return {
        taskId: item.taskId,
        tmuxTaskId: item.tmuxTaskId,
        status: item.status,
        detachedAt: item.detachedAt
      }; }),
      extra: extra || undefined
    };
    var cleanState = JSON.parse(JSON.stringify(state));
    return {
      content: [{ type: "text", text: "portable-devshell durable task checkpoint:\n" + JSON.stringify(cleanState, null, 2) }],
      structuredContent: { portableDevshellWorkspace: cleanState }
    };
  }

  async function syncModelContext(extra) {
    if (!initialized || !snapshot) return;
    try {
      await request("ui/update-model-context", modelContext(extra));
    } catch (_) {}
  }

  async function sendModelMessage(text, extra) {
    await syncModelContext(extra);
    return await request("ui/message", {
      role: "user",
      content: [{ type: "text", text: text }]
    });
  }

  function findTask(taskId) {
    var tasks = snapshot && Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
    return tasks.find(function (task) { return task.taskId === taskId; });
  }

  async function recoverDetachedWait() {
    if (recovering || !appToken || !snapshot) return;
    var background = Array.isArray(snapshot.background) ? snapshot.background : [];
    var item = background.find(function (entry) {
      if (entry.status !== "resolved" || !entry.detachedAt || !entry.taskId) return false;
      var task = findTask(entry.taskId);
      return task && task.status !== "paused";
    });
    if (!item) return;
    recovering = true;
    try {
      var claimed = structured(await callTool("workspace_wait_recover", { waitId: item.waitId }, true));
      await sendModelMessage(
        "Resume the portable-devshell task from its durable checkpoint. A detached background wait completed; do not repeat completed work.",
        { recoveredWait: claimed }
      );
      await refresh(false);
    } catch (error) {
      status.textContent = "Resume available";
      console.error(error);
    } finally {
      recovering = false;
    }
  }

  async function applySnapshot(nextSnapshot, allowRecovery) {
    snapshot = nextSnapshot;
    if (snapshot && Number.isSafeInteger(snapshot.cursor)) cursor = snapshot.cursor;
    render();
    await syncModelContext();
    if (allowRecovery !== false) void recoverDetachedWait();
  }

  async function refresh(allowRecovery) {
    if (!initialized || !ctxId) return;
    try {
      var result = await callTool("workspace_snapshot", {}, false);
      await applySnapshot(structured(result), allowRecovery);
      status.textContent = snapshot && snapshot.instance ? snapshot.instance + " · live" : "Connected";
    } catch (error) {
      status.textContent = "Reconnecting";
      throw error;
    }
  }

  function sleep(milliseconds) {
    return new Promise(function (resolve) { setTimeout(resolve, milliseconds); });
  }

  async function watch() {
    var generation = ++watchGeneration;
    while (generation === watchGeneration) {
      try {
        var result = await callTool("workspace_watch", { cursor: cursor }, false);
        var update = structured(result) || {};
        if (Number.isSafeInteger(update.cursor)) cursor = update.cursor;
        if (update.changed && update.snapshot) {
          await applySnapshot(update.snapshot, true);
        }
        status.textContent = snapshot && snapshot.instance ? snapshot.instance + " · live" : "Connected";
      } catch (error) {
        if (generation !== watchGeneration) return;
        status.textContent = "Reconnecting";
        console.error(error);
        await sleep(1000);
        if (generation !== watchGeneration) return;
        try { await refresh(); } catch (_) {}
      }
    }
  }

  async function connect() {
    try {
      await request("ui/initialize", {
        protocolVersion: "2026-01-26",
        appInfo: { name: "portable-devshell-workspace", version: "0.6.6" },
        appCapabilities: {}
      });
      notify("ui/notifications/initialized", {});
      initialized = true;
      status.textContent = "Connected";
      await refresh();
      void watch();
    } catch (error) {
      status.textContent = "Host bridge unavailable";
      console.error(error);
    }
  }

  async function act(key, name, args) {
    if (busy.has(key)) return null;
    busy.add(key);
    render();
    try {
      var result = structured(await callTool(name, args, true));
      await refresh(false);
      return result;
    } catch (error) {
      status.textContent = "Action failed";
      console.error(error);
      return null;
    } finally {
      busy.delete(key);
      render();
    }
  }

  async function controlTask(taskId, action) {
    var result = await act(taskId, "workspace_task_control", { taskId: taskId, action: action });
    if (result && action === "resume") {
      await sendModelMessage(
        "Resume the portable-devshell task from its durable checkpoint. Do not repeat completed work.",
        { resumedTaskId: taskId }
      );
    }
  }

  async function askTask(taskId) {
    if (busy.has(taskId)) return;
    busy.add(taskId);
    render();
    try {
      await sendModelMessage(
        "Review the current portable-devshell task checkpoint and tell me what needs attention or what should happen next.",
        { askedTaskId: taskId }
      );
    } catch (error) {
      status.textContent = "Ask failed";
      console.error(error);
    } finally {
      busy.delete(taskId);
      render();
    }
  }

  async function answerQuestion(waitId, answer) {
    var result = await act(waitId, "workspace_question_answer", { waitId: waitId, answer: answer });
    var task = result && result.taskId ? findTask(result.taskId) : null;
    if (result && result.detached && task && task.status !== "paused") {
      await sendModelMessage(
        "Resume the portable-devshell task from its durable checkpoint. The user answered the detached question; use that answer and continue without repeating completed work.",
        { answeredQuestion: result }
      );
    }
  }

  async function resumeBackground(taskId) {
    if (busy.has(taskId)) return;
    busy.add(taskId);
    render();
    try {
      await sendModelMessage(
        "Resume the portable-devshell task from its durable checkpoint. Reattach to any detached wait instead of repeating completed work.",
        { resumedTaskId: taskId }
      );
    } catch (error) {
      status.textContent = "Resume failed";
      console.error(error);
    } finally {
      busy.delete(taskId);
      render();
    }
  }

  function questionCard(wait) {
    var payload = wait && wait.payload && typeof wait.payload === "object" ? wait.payload : {};
    var choices = Array.isArray(payload.choices) ? payload.choices : [];
    var disabled = busy.has(wait.waitId) ? " disabled" : "";
    var buttons = choices.map(function (choice) {
      return '<button class="primary" data-question-choice="' + escapeHtml(wait.waitId) + '" data-answer="' + escapeHtml(choice) + '"' + disabled + '>' + escapeHtml(choice) + '</button>';
    }).join("");
    var text = payload.allowText === false ? "" : '<div class="row" style="margin-top:7px"><input data-question-input="' + escapeHtml(wait.waitId) + '" placeholder="Type an answer"><button data-question-submit="' + escapeHtml(wait.waitId) + '"' + disabled + '>Answer</button></div>';
    return '<div class="card"><div class="row between"><span class="title">Agent needs input</span><span class="badge">' + escapeHtml(wait.status) + '</span></div><div class="question">' + escapeHtml(payload.question || "Question") + '</div><div class="row">' + buttons + '</div>' + text + '</div>';
  }

  function approvalCard(approval) {
    var disabled = busy.has(approval.approvalId) ? " disabled" : "";
    return '<div class="card"><div class="row between"><span class="title">Approval required</span><span class="badge">' + escapeHtml(approval.riskLevel || "") + '</span></div><div class="question"><strong>' + escapeHtml(approval.toolName) + '</strong><br><span class="muted">' + escapeHtml(approval.inputSummary || approval.reason || "") + '</span></div><div class="row"><button class="danger" data-approval="' + escapeHtml(approval.approvalId) + '" data-decision="deny"' + disabled + '>Deny</button><button class="primary" data-approval="' + escapeHtml(approval.approvalId) + '" data-decision="approve"' + disabled + '>Approve</button></div></div>';
  }

  function taskCard(task) {
    var disabled = busy.has(task.taskId) ? " disabled" : "";
    var checkpoint = task.checkpoint && task.checkpoint.summary
      ? '<div class="question">' + escapeHtml(task.checkpoint.summary) + '</div>'
      : '';
    var control = task.status === "paused"
      ? '<button class="primary" data-task-action="resume" data-task-id="' + escapeHtml(task.taskId) + '"' + disabled + '>Resume</button>'
      : '<button data-task-action="pause" data-task-id="' + escapeHtml(task.taskId) + '"' + disabled + '>Pause</button>';
    return '<div class="card"><div class="row between"><span class="title">' + escapeHtml(task.title || task.taskId) + '</span><span class="badge">' + escapeHtml(task.status || "") + '</span></div><div class="muted" style="margin-top:5px">' + escapeHtml(task.currentItem || ((task.completed || 0) + "/" + (task.total || 0))) + '</div>' + checkpoint + '<div class="row" style="margin-top:8px"><button data-task-ask="' + escapeHtml(task.taskId) + '"' + disabled + '>Ask</button>' + control + '<button class="danger" data-task-action="cancel" data-task-id="' + escapeHtml(task.taskId) + '"' + disabled + '>Cancel</button></div></div>';
  }

  function backgroundCard(item) {
    var task = item.taskId ? findTask(item.taskId) : null;
    var disabled = item.taskId && busy.has(item.taskId) ? " disabled" : "";
    var resume = item.detachedAt && task && task.status !== "paused" && item.status !== "resolved"
      ? '<div class="row" style="margin-top:8px"><button class="primary" data-background-resume="' + escapeHtml(item.taskId) + '"' + disabled + '>Resume agent</button></div>'
      : '';
    return '<div class="card"><div class="row between"><span class="title">Background task</span><span class="badge">' + escapeHtml(item.status || "") + '</span></div><div class="mono" style="margin-top:5px">' + escapeHtml(item.tmuxTaskId || "") + '</div>' + (item.detachedAt ? '<div class="muted" style="margin-top:4px">Detached from the previous host call</div>' : '') + resume + '</div>';
  }

  function activityCard(item) {
    var completed = item.completedAt ? ' · ' + escapeHtml(item.completedAt) : '';
    var detail = item.inputSummary ? '<div class="muted" style="margin-top:5px">' + escapeHtml(item.inputSummary) + '</div>' : '';
    var error = item.error ? '<div class="muted" style="margin-top:4px">' + escapeHtml(item.error) + '</div>' : '';
    return '<div class="card"><div class="row between"><span class="title mono">' + escapeHtml(item.toolName || "tool") + '</span><span class="badge">' + escapeHtml(item.status || "") + '</span></div>' + detail + error + '<div class="muted" style="margin-top:5px">' + escapeHtml(item.startedAt || "") + completed + '</div></div>';
  }

  function render() {
    if (!snapshot) return;
    var questions = Array.isArray(snapshot.questions) ? snapshot.questions : [];
    var approvals = Array.isArray(snapshot.approvals) ? snapshot.approvals : [];
    var tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
    var background = Array.isArray(snapshot.background) ? snapshot.background : [];
    var activity = Array.isArray(snapshot.activity) ? snapshot.activity : [];
    var html = "";
    if (questions.length) html += '<div class="section-head">Questions</div>' + questions.map(questionCard).join("");
    if (approvals.length) html += '<div class="section-head">Approvals</div>' + approvals.map(approvalCard).join("");
    if (tasks.length) html += '<div class="section-head">Current tasks</div>' + tasks.map(taskCard).join("");
    if (background.length) html += '<div class="section-head">Background</div>' + background.map(backgroundCard).join("");
    if (activity.length) html += '<div class="section-head">Activity</div>' + activity.map(activityCard).join("");
    if (!html) html = '<div class="empty">No active work for this Context.</div>';
    root.innerHTML = html;
  }

  root.addEventListener("click", function (event) {
    var target = event.target.closest("button");
    if (!target) return;
    var waitId = target.getAttribute("data-question-choice") || target.getAttribute("data-question-submit");
    if (waitId) {
      var answer = target.getAttribute("data-answer");
      if (answer == null) {
        var input = root.querySelector('[data-question-input="' + CSS.escape(waitId) + '"]');
        answer = input ? input.value.trim() : "";
      }
      if (answer) void answerQuestion(waitId, answer);
      return;
    }
    var approvalId = target.getAttribute("data-approval");
    if (approvalId) {
      void act(approvalId, "workspace_approval_decide", { approvalId: approvalId, decision: target.getAttribute("data-decision") });
      return;
    }
    var taskId = target.getAttribute("data-task-id");
    var taskAction = target.getAttribute("data-task-action");
    if (taskId && taskAction) {
      void controlTask(taskId, taskAction);
      return;
    }
    var askTaskId = target.getAttribute("data-task-ask");
    if (askTaskId) {
      void askTask(askTaskId);
      return;
    }
    var resumeTaskId = target.getAttribute("data-background-resume");
    if (resumeTaskId) void resumeBackground(resumeTaskId);
  });

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var message = event.data;
    if (!message || message.jsonrpc !== "2.0") return;
    if (message.id !== undefined && pending.has(message.id)) {
      var waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter.reject(message.error); else waiter.resolve(message.result);
      return;
    }
    if (message.method === "ui/notifications/tool-input") {
      var input = message.params && (message.params.arguments || message.params);
      if (input && input.ctxId) ctxId = String(input.ctxId);
    }
    if (message.method === "ui/notifications/tool-result") {
      acceptMeta(message.params && message.params._meta);
      var initial = message.params && message.params.structuredContent;
      if (initial && initial.ctxId) {
        ctxId = String(initial.ctxId);
        snapshot = initial;
        render();
      }
    }
  }, { passive: true });

  if (window.openai && window.openai.toolInput && window.openai.toolInput.ctxId) ctxId = String(window.openai.toolInput.ctxId);
  if (window.openai && window.openai.toolResponseMetadata) acceptMeta(window.openai.toolResponseMetadata);
  if (window.openai && window.openai.toolOutput && window.openai.toolOutput.ctxId) {
    snapshot = window.openai.toolOutput;
    ctxId = String(snapshot.ctxId);
    render();
  }
  void connect();
})();
</script>
</body>
</html>`;
