import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const workspaceAppStableResourceUri = "ui://portable-devshell/workspace/v1.html";
export const workspaceAppLegacyResourceUris: readonly string[] = [
    "ui://portable-devshell/workspace-651c9d0f1042c493.html",
    "ui://portable-devshell/workspace-98410baf51f694b0.html",
    "ui://portable-devshell/workspace-03c4911b6d185e3c.html",
    "ui://portable-devshell/workspace-c978585dba4e38c7.html",
    "ui://portable-devshell/workspace-4305d70d5fdb6a12.html",
];

export const workspaceAppResourceMeta = {
    ui: {
        csp: { connectDomains: [], resourceDomains: [] },
        prefersBorder: false,
    },
    "openai/widgetCSP": { connect_domains: [], resource_domains: [] },
    "openai/widgetDescription": "Compact portable-devshell human interaction surface for the current blocking event.",
    "openai/widgetPrefersBorder": false,
} as const;

export function workspaceAppResourceMetaForPublicBaseUrl(publicBaseUrl?: string) {
    if (publicBaseUrl === undefined) return workspaceAppResourceMeta;
    const url = new URL(publicBaseUrl);
    if (url.hostname === "0.0.0.0" || url.hostname === "[::]") return workspaceAppResourceMeta;
    const domain = url.origin;
    return {
        ...workspaceAppResourceMeta,
        ui: {
            ...workspaceAppResourceMeta.ui,
            domain,
        },
        "openai/widgetDomain": domain,
    } as const;
}

const workspaceSdkScript = loadWorkspaceSdkScript();

export const workspaceAppHtml = String.raw`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root { color-scheme: light dark; font-family: var(--font-sans, ui-sans-serif, system-ui, -apple-system, sans-serif); }
* { box-sizing: border-box; }
body { margin: 0; padding: 8px; background: transparent; color: var(--color-text-primary, CanvasText); }
small, .muted { color: var(--color-text-secondary, color-mix(in srgb, CanvasText 58%, transparent)); font-size: 11px; }
#status { display: block; margin-bottom: 6px; }
.grid { display: grid; gap: 6px; }
.card { border: 1px solid var(--color-border-secondary, color-mix(in srgb, CanvasText 18%, transparent)); border-radius: var(--border-radius-md, 9px); overflow: hidden; background: var(--color-background-primary, color-mix(in srgb, Canvas 94%, CanvasText 6%)); }
.card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 9px 6px; }
.card-body { padding: 0 9px 8px; }
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.row.between { justify-content: space-between; }
.title { font-size: 13px; font-weight: 650; }
.event-name { font-size: 11px; font-weight: 650; }
.question { margin: 3px 0 7px; font-size: 13px; line-height: 1.35; }
button, input { font: inherit; }
button { border: 1px solid var(--color-border-primary, color-mix(in srgb, CanvasText 24%, transparent)); border-radius: var(--border-radius-sm, 7px); padding: 4px 8px; background: var(--color-background-primary, Canvas); color: var(--color-text-primary, CanvasText); cursor: pointer; }
button.primary { font-weight: 650; }
button.danger, .danger-row { color: var(--color-text-danger, CanvasText); }
button:disabled { opacity: .55; cursor: default; }
button:focus-visible, input:focus-visible { outline: 2px solid currentColor; outline-offset: -2px; }
input { width: 100%; min-width: 0; border: 0; border-top: 1px solid var(--color-border-secondary, color-mix(in srgb, CanvasText 14%, transparent)); padding: 8px 9px; background: transparent; color: var(--color-text-primary, CanvasText); }
.badge { border-radius: var(--border-radius-full, 999px); padding: 2px 7px; font-size: 10px; background: var(--color-background-secondary, color-mix(in srgb, CanvasText 10%, transparent)); }
.mono { font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 11px; }
.empty { padding: 8px 9px; text-align: left; font-size: 11px; color: var(--color-text-secondary, color-mix(in srgb, CanvasText 55%, transparent)); }
.choice-row, .action-row { display: flex; width: 100%; align-items: center; justify-content: space-between; gap: 10px; min-height: 34px; padding: 7px 9px; border: 0; border-top: 1px solid var(--color-border-secondary, color-mix(in srgb, CanvasText 14%, transparent)); border-radius: 0; background: transparent; cursor: pointer; font-size: 12px; text-align: left; }
.choice-row:hover, .action-row:hover { background: var(--color-background-secondary, color-mix(in srgb, CanvasText 6%, transparent)); }
.goal-step { display: flex; gap: 7px; align-items: baseline; padding: 4px 0; font-size: 11px; }
.goal-step + .goal-step { border-top: 1px solid var(--color-border-secondary, color-mix(in srgb, CanvasText 10%, transparent)); }
.goal-step .badge { flex: 0 0 auto; }
</style>
</head>
<body>
<small id="status" role="status" aria-live="polite">Connecting…</small>
<div id="root" class="grid"><div class="empty">Waiting for Workspace state…</div></div>
<script>${workspaceSdkScript}</script>
<script>
(function () {
  var root = document.getElementById("root");
  var status = document.getElementById("status");
  var McpApps = globalThis.__portableDevshellMcpApps;
  var App = McpApps.App;
  var app = new App({ name: "portable-devshell-workspace", version: "0.6.8" }, {});
  var requiresExplicitContextId = true;
  var ctxId = "";
  var appToken = "";
  var initialized = false;
  var snapshot = null;
  var cursor = 0;
  var watchGeneration = 0;
  var watchStarted = false;
  var reconnectOnStart = false;
  var recovering = false;
  var busy = new Set();
  var expandedQuestions = new Set();
  var WIDGET_STATE_KEY = "portableDevshellWorkspace";
  var bridgeReady = false;
  var pendingToolResult = null;
  var initialToolResultResolve = null;
  var liveAbortController = null;
  var goalTimer = null;
  var goalContinuationClaimId = "";

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  }

  function callTool(name, args, requiresToken, signal) {
    if (!initialized) return Promise.reject(new Error("Workspace App is not initialized"));
    if (requiresToken && !appToken) return Promise.reject(new Error("Workspace App authorization is unavailable"));
    if (requiresExplicitContextId && !ctxId) return Promise.reject(new Error("Workspace context is unavailable"));
    var input = Object.assign({}, args || {});
    if (requiresExplicitContextId) input.ctxId = ctxId;
    if (requiresToken) input.token = appToken;
    return app.callServerTool(
      { name: name, arguments: input },
      signal ? { signal: signal } : undefined
    ).then(function (result) {
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

  function applyHostContext(context) {
    var record = asRecord(context);
    if (!record) return;
    if (record.theme === "light" || record.theme === "dark") {
      McpApps.applyDocumentTheme(record.theme);
    }
    var styles = asRecord(record.styles);
    var variables = asRecord(styles && styles.variables);
    if (variables) McpApps.applyHostStyleVariables(variables);
    var css = asRecord(styles && styles.css);
    if (css && typeof css.fonts === "string") McpApps.applyHostFonts(css.fonts);
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
    return asRecord(widgetState && widgetState[WIDGET_STATE_KEY]);
  }

  function persistWorkspaceHint() {
    var openai = asRecord(window.openai);
    if (!openai || typeof openai.setWidgetState !== "function") return;
    var state = Object.assign({}, asRecord(openai.widgetState) || {});
    state[WIDGET_STATE_KEY] = requiresExplicitContextId
      ? { requiresExplicitContextId: true, ctxId: ctxId }
      : { requiresExplicitContextId: false };
    try { openai.setWidgetState(state); } catch (_) {}
  }

  function activateCtxId(value) {
    if (!requiresExplicitContextId || !value) return false;
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
    if (!initial) return false;
    var selector = asRecord(initial.contextSelector);
    if (selector && typeof selector.requiresExplicitContextId === "boolean") {
      requiresExplicitContextId = selector.requiresExplicitContextId;
    }
    if (!requiresExplicitContextId) {
      ctxId = "";
      persistWorkspaceHint();
      return true;
    }
    return activateCtxId(initial.ctxId);
  }

  function configureFromOpenAiGlobals(globals) {
    var source = globals || window.openai;
    var result = toolResultFromOpenAiGlobals(source);
    var configured = acceptToolResult(result);
    var hint = workspaceHintFromOpenAiGlobals(source);
    if (!configured && hint) {
      if (typeof hint.requiresExplicitContextId === "boolean") {
        requiresExplicitContextId = hint.requiresExplicitContextId;
        if (!requiresExplicitContextId) configured = true;
        else configured = activateCtxId(hint.ctxId);
      } else if (hint.ctxId) {
        requiresExplicitContextId = true;
        configured = activateCtxId(hint.ctxId);
      }
    }
    return configured || !requiresExplicitContextId || !!ctxId;
  }

  function modelContext(extra) {
    var tasks = snapshot && Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
    var background = snapshot && Array.isArray(snapshot.background) ? snapshot.background : [];
    var state = {
      ...(requiresExplicitContextId ? { ctxId: ctxId } : {}),
      instance: snapshot && snapshot.instance,
      goal: snapshot && snapshot.goal ? snapshot.goal : undefined,
      tasks: tasks.map(function (task) { return {
        taskId: task.taskId,
        title: task.title,
        status: task.status,
        currentItem: task.currentItem,
        checkpoint: task.checkpoint
      }; }),
      background: background.map(function (item) { return {
        goalId: item.goalId,
        taskId: item.taskId,
        tmuxTaskId: item.tmuxTaskId,
        status: item.status,
        detachedAt: item.detachedAt
      }; }),
      extra: extra || undefined
    };
    var cleanState = JSON.parse(JSON.stringify(state));
    return {
      content: [{ type: "text", text: "portable-devshell durable Workspace state:\n" + JSON.stringify(cleanState, null, 2) }],
      structuredContent: { portableDevshellWorkspace: cleanState }
    };
  }

  async function syncModelContext(extra) {
    if (!initialized || !snapshot) return;
    try {
      await app.updateModelContext(modelContext(extra));
    } catch (_) {}
  }

  async function sendModelMessage(text, extra, canSend) {
    await syncModelContext(extra);
    if (canSend && !canSend()) return false;
    await app.sendMessage({
      role: "user",
      content: [{ type: "text", text: text }]
    });
    return true;
  }

  function newGoalContinuationClaimId() {
    if (crypto && typeof crypto.randomUUID === "function") return "goal-continue-" + crypto.randomUUID();
    return "goal-continue-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
  }

  function goalContinuationAvailable() {
    var goal = snapshot && snapshot.goal;
    if (!goal || goal.status !== "active" || visibleEvent() || busy.size > 0 || recovering) return false;
    var background = Array.isArray(snapshot.background) ? snapshot.background : [];
    return background.length === 0;
  }

  function scheduleGoalContinuation(minDelayMs) {
    if (goalTimer) clearTimeout(goalTimer);
    goalTimer = null;
    var goal = snapshot && snapshot.goal;
    if (!goal || goal.status !== "active" || goal.continuationPending || goal.autoContinueExhausted || !goalContinuationAvailable()) return;
    var dueAt = Date.parse(goal.continuationDueAt || "");
    if (!Number.isFinite(dueAt)) return;
    var retryAt = Date.parse(goal.continuationRetryAfter || "");
    var readyAt = Number.isFinite(retryAt) ? Math.max(dueAt, retryAt) : dueAt;
    var delayMs = Math.max(minDelayMs || 0, readyAt - Date.now(), 0);
    goalTimer = setTimeout(function () {
      goalTimer = null;
      void continueGoal();
    }, delayMs);
  }

  async function continueGoal() {
    var goal = snapshot && snapshot.goal;
    if (!goal || goal.status !== "active" || goal.autoContinueExhausted || goal.continuationPending || !goalContinuationAvailable()) return;
    var claimId = goalContinuationClaimId || newGoalContinuationClaimId();
    goalContinuationClaimId = claimId;
    var accepted = false;
    var errorText = "";
    var claimed = false;
    try {
      var claim = structured(await callTool("workspace_goal_continue", {
        action: "claim",
        available: goalContinuationAvailable(),
        claimId: claimId
      }, true));
      if (claim && claim.goal) snapshot.goal = claim.goal;
      if (!claim || !claim.claimed) {
        goalContinuationClaimId = "";
        render();
        scheduleGoalContinuation(30000);
        return;
      }
      claimed = true;
      var validation = structured(await callTool("workspace_goal_continue", {
        action: "validate",
        available: goalContinuationAvailable(),
        claimId: claimId
      }, true));
      if (validation && validation.goal) snapshot.goal = validation.goal;
      if (!validation || !validation.valid) {
        goalContinuationClaimId = "";
        render();
        scheduleGoalContinuation(30000);
        return;
      }
      accepted = await sendModelMessage(
        "Continue working on the active portable-devshell Workspace Goal from its current state. Do not repeat completed steps. Keep the Goal synchronized with execution using workspace_goal(action=\"update\"). When every step is completed or skipped, call workspace_goal(action=\"finish\"). If progress genuinely cannot continue, call workspace_goal(action=\"block\", note=...).",
        { goalContinuation: claim },
        goalContinuationAvailable
      );
    } catch (error) {
      errorText = error instanceof Error ? error.message : String(error);
      console.error(error);
    } finally {
      if (claimed) {
        try {
          var reportArgs = { accepted: accepted, action: "report", claimId: claimId };
          if (errorText) reportArgs.error = errorText;
          var report = structured(await callTool("workspace_goal_continue", reportArgs, true));
          if (report && report.goal) snapshot.goal = report.goal;
        } catch (reportError) {
          console.error(reportError);
        }
      }
      goalContinuationClaimId = "";
      render();
      scheduleGoalContinuation(0);
    }
  }

  function findTask(taskId) {
    var tasks = snapshot && Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
    return tasks.find(function (task) { return task.taskId === taskId; });
  }

  function hasRecoverableWork(item) {
    if (!item) return false;
    if (item.goalId) {
      var goal = snapshot && snapshot.goal;
      return !!goal && goal.goalId === item.goalId && (goal.status === "active" || goal.status === "blocked");
    }
    if (!item.taskId) return true;
    var task = findTask(item.taskId);
    return !!task && task.status !== "paused";
  }

  async function dispatchRecovery(waitId, message, extra) {
    var claimed = structured(await callTool("workspace_wait_recover", { action: "claim", waitId: waitId }, true));
    var dispatched = false;
    try {
      dispatched = await sendModelMessage(
        message,
        Object.assign({}, extra || {}, { recoveredWait: claimed }),
        function () { return hasRecoverableWork(claimed); }
      );
      if (!dispatched) {
        await callTool("workspace_wait_recover", {
          action: "release",
          claimId: claimed.claimId,
          waitId: waitId
        }, true);
        return;
      }
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
      return entry.status === "resolved" && !!entry.detachedAt && hasRecoverableWork(entry);
    });
    if (!item) return;
    recovering = true;
    try {
      await dispatchRecovery(
        item.waitId,
        "Resume portable-devshell durable work from the current Workspace state. A detached background wait completed; do not repeat completed work. If a blocked Workspace Goal can now proceed, call workspace_goal(action=\"resume\") before continuing.",
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
    var selector = asRecord(snapshot && snapshot.contextSelector);
    if (selector && typeof selector.requiresExplicitContextId === "boolean") {
      requiresExplicitContextId = selector.requiresExplicitContextId;
    }
    if (requiresExplicitContextId && snapshot && snapshot.ctxId) ctxId = String(snapshot.ctxId);
    if (!requiresExplicitContextId) ctxId = "";
    if (snapshot && Number.isSafeInteger(snapshot.cursor)) cursor = snapshot.cursor;
    persistWorkspaceHint();
    render();
    await syncModelContext();
    scheduleGoalContinuation(0);
    if (allowRecovery !== false) void recoverDetachedWait();
  }

  async function refresh(allowRecovery) {
    if (!initialized || (requiresExplicitContextId && !ctxId)) return;
    try {
      var result = await callTool("workspace_snapshot", {}, false);
      await applySnapshot(structured(result), allowRecovery);
      status.textContent = snapshot && snapshot.instance ? snapshot.instance + " · live" : "Connected";
    } catch (error) {
      status.textContent = "Reconnecting";
      throw error;
    }
  }

  async function reconnectWorkspace() {
    if (!initialized || (requiresExplicitContextId && !ctxId)) return;
    var result = await callTool("workspace_reconnect", {}, false);
    await applySnapshot(structured(result), true);
    status.textContent = snapshot && snapshot.instance ? snapshot.instance + " · live" : "Connected";
  }

  function sleep(milliseconds) {
    return new Promise(function (resolve) { setTimeout(resolve, milliseconds); });
  }

  async function watch() {
    var generation = ++watchGeneration;
    while (generation === watchGeneration) {
      var controller = new AbortController();
      liveAbortController = controller;
      try {
        var result = await callTool("workspace_watch", { cursor: cursor }, false, controller.signal);
        if (generation !== watchGeneration) return;
        var update = structured(result) || {};
        if (Number.isSafeInteger(update.cursor)) cursor = update.cursor;
        if (update.changed && update.snapshot) {
          await applySnapshot(update.snapshot, true);
        }
        status.textContent = snapshot && snapshot.instance ? snapshot.instance + " · live" : "Connected";
      } catch (error) {
        if (generation !== watchGeneration || controller.signal.aborted) return;
        status.textContent = "Reconnecting";
        console.error(error);
        await sleep(1000);
        if (generation !== watchGeneration) return;
        try { await refresh(); } catch (_) {}
      } finally {
        if (liveAbortController === controller) liveAbortController = null;
      }
    }
  }

  async function startLive() {
    if (!initialized || (requiresExplicitContextId && !ctxId) || watchStarted) return;
    watchStarted = true;
    try {
      if (reconnectOnStart) {
        reconnectOnStart = false;
        await reconnectWorkspace();
      } else {
        await refresh();
      }
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
    if (liveAbortController) liveAbortController.abort();
    liveAbortController = null;
    if (goalTimer) clearTimeout(goalTimer);
    goalTimer = null;
    watchStarted = false;
    initialized = false;
  }

  app.ontoolinput = function (params) {
    var input = params && params.arguments;
    if (requiresExplicitContextId && input && input.ctxId) activateCtxId(input.ctxId);
  };
  app.ontoolresult = acceptInitialOrLiveToolResult;
  app.ontoolcancelled = function () {
    status.textContent = snapshot && snapshot.instance ? snapshot.instance + " · live" : "Connected";
    if (initialized) void startLive();
  };
  app.onhostcontextchanged = applyHostContext;
  app.onteardown = async function () {
    stopLive();
    return {};
  };

  async function connect() {
    try {
      await app.connect();
      applyHostContext(app.getHostContext());
      bridgeReady = true;
      initialized = true;
      status.textContent = "Connected";
      var initialResult = await waitForInitialToolResult(300);
      if (initialResult) acceptToolResult(initialResult);
      else {
        reconnectOnStart = !!window.openai;
        configureFromOpenAiGlobals();
      }
      if (requiresExplicitContextId && !ctxId) {
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
    if (result && result.detached && hasRecoverableWork(result)) {
      await dispatchRecovery(
        result.waitId,
        "Resume portable-devshell durable work from the current Workspace state. The user answered the detached question; use that answer and continue without repeating completed work. If a blocked Workspace Goal can now proceed, call workspace_goal(action=\"resume\") before continuing.",
        { answeredQuestion: result }
      );
      await refresh(false);
    }
  }

  function visibleEvent() {
    if (!snapshot) return null;
    if (snapshot.currentEvent && typeof snapshot.currentEvent === "object") return snapshot.currentEvent;
    var questions = Array.isArray(snapshot.questions) ? snapshot.questions : [];
    if (questions.length) return Object.assign({ kind: "question", name: "workspace_ask", eventName: "user.answer" }, questions[0]);
    var approvals = Array.isArray(snapshot.approvals) ? snapshot.approvals : [];
    if (approvals.length) return Object.assign({ kind: "approval", name: approvals[0].toolName, eventName: "approval.decision" }, approvals[0]);
    var background = Array.isArray(snapshot.background) ? snapshot.background : [];
    var tmux = background.find(function (item) { return item.status === "waiting"; });
    if (tmux) return Object.assign({ kind: "tmux", name: "tmux_run", eventName: "tmux.task.completed" }, tmux);
    return null;
  }

  function eventHead(item) {
    return '<div class="card-head"><span class="event-name">' + escapeHtml(item.name || item.kind || "event") + '</span><span class="badge">' + escapeHtml(item.status || "waiting") + '</span></div>';
  }

  function questionCard(item) {
    var payload = item && item.payload && typeof item.payload === "object" ? item.payload : {};
    var choices = Array.isArray(payload.choices) ? payload.choices : [];
    var disabled = busy.has(item.waitId);
    var expanded = expandedQuestions.has(item.waitId);
    var shownChoices = expanded ? choices : choices.slice(0, 5);
    var rows = shownChoices.map(function (choice) {
      return '<button type="button" class="choice-row"' + (disabled ? ' disabled' : '') + ' data-question-choice="' + escapeHtml(item.waitId) + '" data-answer="' + escapeHtml(choice) + '"><span>' + escapeHtml(choice) + '</span><span class="muted" aria-hidden="true">›</span></button>';
    }).join("");
    if (!expanded && choices.length > shownChoices.length) {
      rows += '<button type="button" class="choice-row" data-question-expand="' + escapeHtml(item.waitId) + '" aria-expanded="false"><span>Show ' + (choices.length - shownChoices.length) + ' more</span><span class="muted" aria-hidden="true">+</span></button>';
    }
    var text = payload.allowText === false ? "" : '<input aria-label="Answer" data-question-input="' + escapeHtml(item.waitId) + '" placeholder="Type an answer · Enter"' + (disabled ? ' disabled' : '') + '>';
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
      action = '<button type="button" class="action-row danger-row"' + (disabled ? ' disabled' : '') + ' data-wait-interrupt="' + escapeHtml(item.waitId) + '"><span>Interrupt wait</span><span class="muted">task keeps running</span></button>';
    }
    return '<div class="card">' + eventHead(item) + '<div class="card-body"><div class="muted">event · ' + escapeHtml(item.eventName || "tmux.task.completed") + '</div><div class="question">Waiting for task completion</div><div class="mono">' + escapeHtml(item.tmuxTaskId || "") + '</div></div>' + action + '</div>';
  }

  function goalCard() {
    var goal = snapshot && snapshot.goal;
    if (!goal) return "";
    var steps = Array.isArray(goal.steps) ? goal.steps : [];
    var rows = steps.map(function (step) {
      var note = step.note ? '<div class="muted">' + escapeHtml(step.note) + '</div>' : '';
      return '<div class="goal-step"><span class="badge">' + escapeHtml(step.status) + '</span><div><div>' + escapeHtml(step.text) + '</div>' + note + '</div></div>';
    }).join("");
    var stop = "";
    if (goal.status === "active" || goal.status === "blocked") {
      stop = '<button type="button" class="action-row danger-row" aria-label="Stop Goal" data-goal-stop="' + escapeHtml(goal.goalId) + '"' + (busy.has("goal-stop") ? ' disabled' : '') + '><span>Stop Goal</span><span class="muted">keep processes running</span></button>';
    }
    var continuation = goal.status === "active"
      ? '<div class="muted">continuations · ' + escapeHtml(goal.continuationCount) + '/' + escapeHtml(goal.maxContinuations) + '</div>'
      : '';
    return '<div class="card"><div class="card-head"><span class="event-name">workspace_goal</span><span class="badge">' + escapeHtml(goal.status) + '</span></div><div class="card-body"><div class="question">' + escapeHtml(goal.objective) + '</div>' + continuation + '<div>' + rows + '</div></div>' + stop + '</div>';
  }

  function render() {
    if (!snapshot) return;
    var item = visibleEvent();
    var eventCard = !item ? '<div class="card"><div class="empty">No blocking event.</div></div>'
      : item.kind === "question" ? questionCard(item)
      : item.kind === "approval" ? approvalCard(item)
      : item.kind === "tmux" ? tmuxWaitCard(item)
      : '<div class="card"><div class="empty">Unknown event.</div></div>';
    root.innerHTML = goalCard() + eventCard;
  }

  root.addEventListener("click", function (event) {
    var goalStop = event.target.closest("[data-goal-stop]");
    if (goalStop && !goalStop.hasAttribute("disabled")) {
      void act("goal-stop", "workspace_goal_stop", {});
      return;
    }
    var expand = event.target.closest("[data-question-expand]");
    if (expand) {
      expandedQuestions.add(expand.getAttribute("data-question-expand"));
      render();
      return;
    }
    var choice = event.target.closest("[data-question-choice]");
    if (choice && !choice.hasAttribute("disabled")) {
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
    if (interrupt && !interrupt.hasAttribute("disabled")) {
      var waitId = interrupt.getAttribute("data-wait-interrupt");
      void act(waitId, "workspace_wait_interrupt", { waitId: waitId });
      return;
    }
  });

  root.addEventListener("keydown", function (event) {
    var input = event.target.closest && event.target.closest("[data-question-input]");
    if (input && event.key === "Enter") {
      var answer = input.value.trim();
      var waitId = input.getAttribute("data-question-input");
      if (answer && waitId) void answerQuestion(waitId, answer);
    }
  });

  window.addEventListener("openai:set_globals", function (event) {
    var detail = event && event.detail;
    reconnectOnStart = true;
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
    const exports = exportBlock?.[1];
    const exportedSymbol = (name: string): string | undefined => {
        const match = exports?.match(new RegExp(`(?:^|,)\\s*([$A-Za-z_][$\\w]*)\\s+as\\s+${name}\\s*(?:,|$)`));
        return match?.[1];
    };
    const appExport = exportedSymbol("App");
    const applyDocumentThemeExport = exportedSymbol("applyDocumentTheme");
    const applyHostStyleVariablesExport = exportedSymbol("applyHostStyleVariables");
    const applyHostFontsExport = exportedSymbol("applyHostFonts");
    if (
        exportBlock?.index === undefined ||
        appExport === undefined ||
        applyDocumentThemeExport === undefined ||
        applyHostStyleVariablesExport === undefined ||
        applyHostFontsExport === undefined
    ) {
        throw new Error("Unable to locate required exports in @modelcontextprotocol/ext-apps/app-with-deps.");
    }
    if (source.toLowerCase().includes("</script")) {
        throw new Error("MCP Apps browser bundle cannot be embedded safely in Workspace HTML.");
    }
    return `${source.slice(0, exportBlock.index)}globalThis.__portableDevshellMcpApps={` +
        `App:${appExport},` +
        `applyDocumentTheme:${applyDocumentThemeExport},` +
        `applyHostFonts:${applyHostFontsExport},` +
        `applyHostStyleVariables:${applyHostStyleVariablesExport}` +
        `};`;
}
