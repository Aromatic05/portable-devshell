import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const workspaceAppStableResourceUri = "ui://portable-devshell/workspace/v1.html";
export const workspaceAppLegacyResourceUris: readonly string[] = [];

const workspaceSdkScript = loadWorkspaceSdkScript();

export const workspaceAppHtml = String.raw`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; padding: 8px; background: transparent; color: CanvasText; }
header { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 6px; }
h1 { font-size: 13px; margin: 0; font-weight: 650; }
small, .muted { color: color-mix(in srgb, CanvasText 58%, transparent); font-size: 11px; }
.grid { display: grid; }
.card { border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 9px; overflow: hidden; background: color-mix(in srgb, Canvas 94%, CanvasText 6%); }
.card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 9px 6px; }
.card-body { padding: 0 9px 8px; }
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.row.between { justify-content: space-between; }
.title { font-size: 13px; font-weight: 650; }
.event-name { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; font-weight: 650; }
.question { margin: 3px 0 7px; font-size: 13px; line-height: 1.35; }
button, input { font: inherit; }
button { border: 1px solid color-mix(in srgb, CanvasText 24%, transparent); border-radius: 7px; padding: 4px 8px; background: Canvas; color: CanvasText; cursor: pointer; }
button.primary { font-weight: 650; }
button.danger { color: #c43b3b; }
button:disabled { opacity: .55; cursor: default; }
input { width: 100%; min-width: 0; border: 0; border-top: 1px solid color-mix(in srgb, CanvasText 14%, transparent); padding: 8px 9px; background: transparent; color: CanvasText; outline: none; }
.badge { border-radius: 999px; padding: 2px 7px; font-size: 10px; background: color-mix(in srgb, CanvasText 10%, transparent); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
.empty { padding: 8px 9px; text-align: left; font-size: 11px; color: color-mix(in srgb, CanvasText 55%, transparent); }
.choice-list { max-height: 170px; overflow: auto; }
.choice-row, .action-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 34px; padding: 7px 9px; border-top: 1px solid color-mix(in srgb, CanvasText 14%, transparent); cursor: pointer; font-size: 12px; }
.choice-row:hover, .action-row:hover { background: color-mix(in srgb, CanvasText 6%, transparent); }
.choice-row[aria-disabled="true"], .action-row[aria-disabled="true"] { opacity: .55; cursor: default; }
.danger-row { color: #c43b3b; }
</style>
</head>
<body>
<header><h1>portable-devshell</h1><small id="status">Connecting…</small></header>
<div id="root" class="grid"><div class="empty">Waiting for Workspace state…</div></div>
<script>${workspaceSdkScript}</script>
<script>
(function () {
  var root = document.getElementById("root");
  var status = document.getElementById("status");
  var App = globalThis.__portableDevshellMcpApp;
  var app = new App({ name: "portable-devshell-workspace", version: "0.6.8" }, {});
  var ctxId = "";
  var appToken = "";
  var initialized = false;
  var snapshot = null;
  var cursor = 0;
  var watchGeneration = 0;
  var watchStarted = false;
  var recovering = false;
  var busy = new Set();
  var WIDGET_STATE_KEY = "portableDevshellWorkspace";
  var bridgeReady = false;
  var pendingToolResult = null;
  var initialToolResultResolve = null;

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  }

  function callTool(name, args, requiresToken) {
    if (!initialized) return Promise.reject(new Error("Workspace App is not initialized"));
    if (requiresToken && !appToken) return Promise.reject(new Error("Workspace App authorization is unavailable"));
    var input = Object.assign({ ctxId: ctxId }, args || {});
    if (requiresToken) input.token = appToken;
    return app.callServerTool({ name: name, arguments: input }).then(function (result) {
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

  function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  }

  function toolResultFromOpenAiGlobals(globals) {
    var openai = asRecord(globals);
    if (!openai) return null;
    var metadata = asRecord(openai.toolResponseMetadata);
    var envelope = metadata && (asRecord(metadata.mcp_tool_result) || asRecord(metadata.call_tool_result));
    if (!envelope) return null;
    var output = asRecord(openai.toolOutput);
    return output ? Object.assign({}, envelope, { structuredContent: output }) : envelope;
  }

  function workspaceHintFromOpenAiGlobals(globals) {
    var openai = asRecord(globals);
    var widgetState = asRecord(openai && openai.widgetState);
    var stored = asRecord(widgetState && widgetState[WIDGET_STATE_KEY]);
    return stored && stored.ctxId ? String(stored.ctxId) : "";
  }

  function persistWorkspaceHint() {
    if (!ctxId) return;
    var openai = asRecord(window.openai);
    if (!openai || typeof openai.setWidgetState !== "function") return;
    var state = Object.assign({}, asRecord(openai.widgetState) || {});
    state[WIDGET_STATE_KEY] = { ctxId: ctxId };
    try {
      var result = openai.setWidgetState(state);
      if (result && typeof result.catch === "function") result.catch(function () {});
    } catch (_) {}
  }

  function activateCtxId(value) {
    if (!value) return false;
    var nextCtxId = String(value);
    if (ctxId && ctxId !== nextCtxId) {
      watchGeneration += 1;
      watchStarted = false;
      snapshot = null;
      cursor = 0;
    }
    ctxId = nextCtxId;
    persistWorkspaceHint();
    if (initialized) void startLive();
    return true;
  }

  function acceptToolResult(result) {
    if (!result) return false;
    acceptMeta(result._meta);
    var initial = asRecord(result.structuredContent);
    if (!initial || !initial.ctxId) return false;
    return activateCtxId(initial.ctxId);
  }

  function configureFromOpenAiGlobals(globals) {
    var source = globals || window.openai;
    var result = toolResultFromOpenAiGlobals(source);
    var configured = acceptToolResult(result);
    if (!ctxId) configured = activateCtxId(workspaceHintFromOpenAiGlobals(source)) || configured;
    return configured || !!ctxId;
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
      await app.updateModelContext(modelContext(extra));
    } catch (_) {}
  }

  async function sendModelMessage(text, extra) {
    await syncModelContext(extra);
    return await app.sendMessage({
      role: "user",
      content: [{ type: "text", text: text }]
    });
  }

  function findTask(taskId) {
    var tasks = snapshot && Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
    return tasks.find(function (task) { return task.taskId === taskId; });
  }

  async function dispatchRecovery(waitId, message, extra) {
    var claimed = structured(await callTool("workspace_wait_recover", { action: "claim", waitId: waitId }, true));
    var dispatched = false;
    try {
      await sendModelMessage(message, Object.assign({}, extra || {}, { recoveredWait: claimed }));
      dispatched = true;
      await callTool("workspace_wait_recover", {
        action: "complete",
        claimId: claimed.claimId,
        waitId: waitId
      }, true);
    } catch (error) {
      if (!dispatched && claimed && claimed.claimId) {
        await callTool("workspace_wait_recover", {
          action: "release",
          claimId: claimed.claimId,
          waitId: waitId
        }, true).catch(function () {});
      }
      throw error;
    }
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
      await dispatchRecovery(
        item.waitId,
        "Resume the portable-devshell task from its durable checkpoint. A detached background wait completed; do not repeat completed work.",
        { backgroundWait: item }
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
    if (snapshot && snapshot.ctxId) ctxId = String(snapshot.ctxId);
    if (snapshot && Number.isSafeInteger(snapshot.cursor)) cursor = snapshot.cursor;
    persistWorkspaceHint();
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
        if (generation !== watchGeneration) return;
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

  async function startLive() {
    if (!initialized || !ctxId || watchStarted) return;
    watchStarted = true;
    try {
      await refresh();
      void watch();
    } catch (error) {
      watchStarted = false;
      throw error;
    }
  }

  function waitForInitialToolResult(timeoutMs) {
    if (pendingToolResult) {
      var result = pendingToolResult;
      pendingToolResult = null;
      return Promise.resolve(result);
    }
    return new Promise(function (resolve) {
      var timer = setTimeout(function () {
        if (initialToolResultResolve === finish) initialToolResultResolve = null;
        resolve(null);
      }, timeoutMs);
      function finish(result) {
        clearTimeout(timer);
        if (initialToolResultResolve === finish) initialToolResultResolve = null;
        resolve(result);
      }
      initialToolResultResolve = finish;
    });
  }

  function acceptInitialOrLiveToolResult(result) {
    if (initialToolResultResolve) {
      var resolve = initialToolResultResolve;
      initialToolResultResolve = null;
      resolve(result);
      return;
    }
    if (!bridgeReady) {
      pendingToolResult = result;
      return;
    }
    acceptToolResult(result);
  }

  function stopLive() {
    watchGeneration += 1;
    watchStarted = false;
    initialized = false;
  }

  app.ontoolinput = function (params) {
    var input = params && params.arguments;
    if (input && input.ctxId) activateCtxId(input.ctxId);
  };
  app.ontoolresult = acceptInitialOrLiveToolResult;
  app.ontoolcancelled = function () {
    status.textContent = "Cancelled";
  };
  app.onteardown = async function () {
    stopLive();
    return {};
  };

  async function connect() {
    try {
      await app.connect();
      bridgeReady = true;
      initialized = true;
      status.textContent = "Connected";
      var initialResult = await waitForInitialToolResult(300);
      if (initialResult) acceptToolResult(initialResult);
      else configureFromOpenAiGlobals();
      if (!ctxId) {
        status.textContent = "Waiting for Workspace identity";
        return;
      }
      await startLive();
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

  async function answerQuestion(waitId, answer) {
    var result = await act(waitId, "workspace_question_answer", { waitId: waitId, answer: answer });
    var task = result && result.taskId ? findTask(result.taskId) : null;
    if (result && result.detached && task && task.status !== "paused") {
      await dispatchRecovery(
        result.waitId,
        "Resume the portable-devshell task from its durable checkpoint. The user answered the detached question; use that answer and continue without repeating completed work.",
        { answeredQuestion: result }
      );
      await refresh(false);
    }
  }

  function visibleEvent() {
    if (!snapshot) return null;
    if (snapshot.currentEvent && typeof snapshot.currentEvent === "object") return snapshot.currentEvent;
    var questions = Array.isArray(snapshot.questions) ? snapshot.questions : [];
    if (questions.length) return Object.assign({ kind: "question", name: "ask_question", eventName: "user.answer" }, questions[0]);
    var approvals = Array.isArray(snapshot.approvals) ? snapshot.approvals : [];
    if (approvals.length) return Object.assign({ kind: "approval", name: approvals[0].toolName, eventName: "approval.decision" }, approvals[0]);
    var background = Array.isArray(snapshot.background) ? snapshot.background : [];
    var tmux = background.find(function (item) { return item.status === "waiting"; });
    if (tmux) return Object.assign({ kind: "tmux", name: "tmux_wait", eventName: "tmux.task.completed" }, tmux);
    return null;
  }

  function eventHead(item) {
    return '<div class="card-head"><span class="event-name">' + escapeHtml(item.name || item.kind || "event") + '</span><span class="badge">' + escapeHtml(item.status || "waiting") + '</span></div>';
  }

  function questionCard(item) {
    var payload = item && item.payload && typeof item.payload === "object" ? item.payload : {};
    var choices = Array.isArray(payload.choices) ? payload.choices : [];
    var disabled = busy.has(item.waitId);
    var rows = choices.map(function (choice) {
      return '<div class="choice-row" role="button" tabindex="0" aria-disabled="' + disabled + '" data-question-choice="' + escapeHtml(item.waitId) + '" data-answer="' + escapeHtml(choice) + '"><span>' + escapeHtml(choice) + '</span><span class="muted">›</span></div>';
    }).join("");
    var text = payload.allowText === false ? "" : '<input data-question-input="' + escapeHtml(item.waitId) + '" placeholder="Type an answer · Enter"' + (disabled ? ' disabled' : '') + '>';
    return '<div class="card">' + eventHead(item) + '<div class="card-body"><div class="muted">event · ' + escapeHtml(item.eventName || "user.answer") + '</div><div class="question">' + escapeHtml(payload.question || "Question") + '</div></div><div class="choice-list">' + rows + '</div>' + text + '</div>';
  }

  function approvalCard(item) {
    var disabled = busy.has(item.approvalId) ? " disabled" : "";
    return '<div class="card">' + eventHead(item) + '<div class="card-body"><div class="muted">event · ' + escapeHtml(item.eventName || "approval.decision") + '</div><div class="question"><strong>' + escapeHtml(item.toolName || item.name) + '</strong><br><span class="muted">' + escapeHtml(item.inputSummary || item.reason || "") + '</span></div><div class="row"><button class="danger" data-approval="' + escapeHtml(item.approvalId) + '" data-decision="deny"' + disabled + '>Deny</button><button class="primary" data-approval="' + escapeHtml(item.approvalId) + '" data-decision="approve"' + disabled + '>Approve</button></div></div></div>';
  }

  function tmuxWaitCard(item) {
    var key = item.waitId || item.taskId || item.tmuxTaskId;
    var disabled = busy.has(key);
    var action = "";
    if (item.status === "waiting") {
      action = '<div class="action-row danger-row" role="button" tabindex="0" aria-disabled="' + disabled + '" data-wait-interrupt="' + escapeHtml(item.waitId) + '"><span>Interrupt wait</span><span class="muted">task keeps running</span></div>';
    }
    return '<div class="card">' + eventHead(item) + '<div class="card-body"><div class="muted">event · ' + escapeHtml(item.eventName || "tmux.task.completed") + '</div><div class="question">Waiting for task completion</div><div class="mono">' + escapeHtml(item.tmuxTaskId || "") + '</div></div>' + action + '</div>';
  }

  function render() {
    if (!snapshot) return;
    var item = visibleEvent();
    if (!item) {
      root.innerHTML = '<div class="card"><div class="empty">No blocking event.</div></div>';
      return;
    }
    root.innerHTML = item.kind === "question" ? questionCard(item)
      : item.kind === "approval" ? approvalCard(item)
      : item.kind === "tmux" ? tmuxWaitCard(item)
      : '<div class="card"><div class="empty">Unknown event.</div></div>';
  }

  root.addEventListener("click", function (event) {
    var choice = event.target.closest("[data-question-choice]");
    if (choice && choice.getAttribute("aria-disabled") !== "true") {
      void answerQuestion(choice.getAttribute("data-question-choice"), choice.getAttribute("data-answer"));
      return;
    }
    var target = event.target.closest("button");
    if (target) {
      var approvalId = target.getAttribute("data-approval");
      if (approvalId) {
        void act(approvalId, "workspace_approval_decide", { approvalId: approvalId, decision: target.getAttribute("data-decision") });
        return;
      }
    }
    var interrupt = event.target.closest("[data-wait-interrupt]");
    if (interrupt && interrupt.getAttribute("aria-disabled") !== "true") {
      var waitId = interrupt.getAttribute("data-wait-interrupt");
      void act(waitId, "workspace_wait_interrupt", { waitId: waitId });
      return;
    }
  });

  root.addEventListener("keydown", function (event) {
    var choice = event.target.closest && event.target.closest("[data-question-choice]");
    if (choice && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      choice.click();
      return;
    }
    var action = event.target.closest && event.target.closest("[data-wait-interrupt]");
    if (action && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      action.click();
      return;
    }
    var input = event.target.closest && event.target.closest("[data-question-input]");
    if (input && event.key === "Enter") {
      var answer = input.value.trim();
      var waitId = input.getAttribute("data-question-input");
      if (answer && waitId) void answerQuestion(waitId, answer);
    }
  });

  window.addEventListener("openai:set_globals", function (event) {
    var detail = event && event.detail;
    if (configureFromOpenAiGlobals(detail && detail.globals) && initialized) void startLive();
  });
  window.addEventListener("beforeunload", function () {
    stopLive();
    void app.close();
  });
  void connect();
})();
</script>
</body>
</html>`;

const workspaceAppDigest = createHash("sha256").update(workspaceAppHtml).digest("hex").slice(0, 16);
export const workspaceAppResourceUri = `ui://portable-devshell/workspace-${workspaceAppDigest}.html`;
export const workspaceAppResourceUris = [
    workspaceAppResourceUri,
    workspaceAppStableResourceUri,
    ...workspaceAppLegacyResourceUris,
] as const;

function loadWorkspaceSdkScript(): string {
    const path = fileURLToPath(import.meta.resolve("@modelcontextprotocol/ext-apps/app-with-deps"));
    const source = readFileSync(path, "utf8").trimEnd();
    const exportBlock = source.match(/export\{([\s\S]+)\};$/);
    const appExport = exportBlock?.[1].match(/(?:^|,)([$A-Za-z_][$\w]*) as App(?:,|$)/);
    if (exportBlock?.index === undefined || appExport == null) {
        throw new Error("Unable to locate App export in @modelcontextprotocol/ext-apps/app-with-deps.");
    }
    if (source.toLowerCase().includes("</script")) {
        throw new Error("MCP Apps browser bundle cannot be embedded safely in Workspace HTML.");
    }
    return `${source.slice(0, exportBlock.index)}globalThis.__portableDevshellMcpApp=${appExport[1]};`;
}
