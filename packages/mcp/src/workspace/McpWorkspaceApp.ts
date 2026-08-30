import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const workspaceAppStableResourceUri =
    "ui://portable-devshell/workspace/v1.html";
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
    "openai/widgetDescription":
        "Compact portable-devshell human interaction surface for the current blocking event.",
    "openai/widgetPrefersBorder": false,
} as const;

export function workspaceAppResourceMetaForPublicBaseUrl(
    publicBaseUrl?: string,
) {
    if (publicBaseUrl === undefined) return workspaceAppResourceMeta;
    const url = new URL(publicBaseUrl);
    if (url.hostname === "0.0.0.0" || url.hostname === "[::]")
        return workspaceAppResourceMeta;
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
#status:empty { display: none; }
.grid { display: grid; gap: 6px; }
.card { border: 1px solid var(--color-border-secondary, color-mix(in srgb, CanvasText 18%, transparent)); border-radius: var(--border-radius-md, 9px); overflow: hidden; background: var(--color-background-primary, color-mix(in srgb, Canvas 94%, CanvasText 6%)); }
.card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 9px 6px; }
.card-body { padding: 0 9px 8px; }
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.event-name { font-size: 11px; font-weight: 650; }
.question { margin: 3px 0 7px; font-size: 13px; line-height: 1.35; }
button, input { font: inherit; }
button { border: 1px solid var(--color-border-primary, color-mix(in srgb, CanvasText 24%, transparent)); border-radius: var(--border-radius-sm, 7px); padding: 4px 8px; background: var(--color-background-primary, Canvas); color: var(--color-text-primary, CanvasText); cursor: pointer; }
button.primary { font-weight: 650; }
button.danger, .danger-row { color: var(--color-text-danger, CanvasText); }
button:disabled { opacity: .55; cursor: default; }
button:focus-visible, input:focus-visible { outline: 2px solid currentColor; outline-offset: -2px; }
input { width: 100%; min-width: 0; border: 0; padding: 8px 9px; background: transparent; color: var(--color-text-primary, CanvasText); }
.badge { border-radius: var(--border-radius-full, 999px); padding: 2px 7px; font-size: 10px; background: var(--color-background-secondary, color-mix(in srgb, CanvasText 10%, transparent)); }
.mono { font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 11px; }
.choice-row, .action-row { display: flex; width: 100%; align-items: center; justify-content: space-between; gap: 10px; min-height: 34px; padding: 7px 9px; border: 0; border-top: 1px solid var(--color-border-secondary, color-mix(in srgb, CanvasText 14%, transparent)); border-radius: 0; background: transparent; cursor: pointer; font-size: 12px; text-align: left; }
.choice-row:hover, .action-row:hover { background: var(--color-background-secondary, color-mix(in srgb, CanvasText 6%, transparent)); }
.answer-row { display: flex; align-items: center; border-top: 1px solid var(--color-border-secondary, color-mix(in srgb, CanvasText 14%, transparent)); }
.answer-row input { flex: 1 1 auto; }
.answer-row button { flex: 0 0 auto; margin-right: 7px; }
.background-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 9px; }
.background-copy { min-width: 0; }
.background-copy .row { gap: 6px; }
.background-row > button { flex: 0 0 auto; }
.detail { margin-top: 6px; line-height: 1.35; }
.goal-current { margin-top: 7px; padding-top: 7px; border-top: 1px solid var(--color-border-secondary, color-mix(in srgb, CanvasText 10%, transparent)); font-size: 12px; line-height: 1.35; }
.goal-note { margin-top: 7px; font-size: 11px; line-height: 1.35; }
</style>
</head>
<body>
<small id="status" role="status" aria-live="polite">Connecting…</small>
<div id="root" class="grid"></div>
<script>${workspaceSdkScript}</script>
<script>
(function () {
  var root = document.getElementById("root");
  var status = document.getElementById("status");
  var McpApps = globalThis.__portableDevshellMcpApps;
  var App = McpApps.App;
  var app = new App({ name: "portable-devshell-workspace", version: "0.6.8" }, {});
  var ctxId = "";
  var appToken = "";
  var liveAuthorizationEstablished = false;
  var initialized = false;
  var snapshot = null;
  var cursor = 0;
  var watchGeneration = 0;
  var watchStarted = false;
  var reconnectOnStart = false;
  var recovering = false;
  var busy = new Set();
  var confirmingTaskCancel = new Map();
  var expandedQuestions = new Set();
  var WIDGET_STATE_KEY = "portableDevshellWorkspace";
  var RESUME_MESSAGE = "Resume the existing portable-devshell work from the current Workspace state. Do not repeat completed work or restart the original command. Read the Workspace state and triggering result before acting. Reuse any existing tmux task instead of starting it again. For tmux waits, a timeout or user interruption ends only the wait and does not stop the task. If a blocked Workspace Goal can now proceed, call workspace_goal with action=resume before continuing.";
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
    if (!ctxId) return Promise.reject(new Error("Workspace context is unavailable"));
    var input = Object.assign({}, args || {});
    input.ctxId = ctxId;
    if (requiresToken) input.token = appToken;
    return app.callServerTool(
      { name: name, arguments: input },
      signal ? { signal: signal } : undefined
    ).then(function (result) {
      acceptMeta(result && result._meta, true);
      return result;
    });
  }

  function structured(result) {
    return result && result.structuredContent ? result.structuredContent : result;
  }

  function acceptMeta(meta, authoritative) {
    var hidden = meta && meta["portable-devshell/workspace"];
    if (!hidden || !hidden.token) return;
    if (liveAuthorizationEstablished && authoritative !== true) return;
    appToken = String(hidden.token);
    if (authoritative === true) liveAuthorizationEstablished = true;
    persistWorkspaceHint();
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
    if (!widgetState) return null;
    var privateContent = asRecord(widgetState.privateContent);
    return asRecord(privateContent && privateContent[WIDGET_STATE_KEY]) ||
      asRecord(widgetState[WIDGET_STATE_KEY]);
  }

  function persistWorkspaceHint() {
    var openai = asRecord(window.openai);
    if (!openai || typeof openai.setWidgetState !== "function") return;
    var current = asRecord(openai.widgetState) || {};
    var privateContent = Object.assign({}, asRecord(current.privateContent) || {});
    var legacyHint = asRecord(current[WIDGET_STATE_KEY]);
    if (!privateContent[WIDGET_STATE_KEY] && legacyHint) {
      privateContent[WIDGET_STATE_KEY] = legacyHint;
    }
    var previousHint = asRecord(privateContent[WIDGET_STATE_KEY]);
    var retainedToken = !appToken && previousHint && String(previousHint.ctxId || "") === ctxId &&
      typeof previousHint.token === "string" && previousHint.token
        ? String(previousHint.token)
        : "";
    var persistedToken = appToken || retainedToken;
    privateContent[WIDGET_STATE_KEY] = persistedToken
      ? { ctxId: ctxId, token: persistedToken }
      : { ctxId: ctxId };
    var state = {
      modelContent: current.modelContent === undefined ? null : current.modelContent,
      privateContent: privateContent,
      imageIds: Array.isArray(current.imageIds) ? current.imageIds : []
    };
    try { openai.setWidgetState(state); } catch (_) {}
  }

  function assignCtxId(value) {
    if (!value) return false;
    var nextCtxId = String(value);
    if (ctxId && ctxId !== nextCtxId && liveAuthorizationEstablished) return false;
    if (ctxId && ctxId !== nextCtxId) {
      watchGeneration += 1;
      watchStarted = false;
      snapshot = null;
      cursor = 0;
      appToken = "";
      liveAuthorizationEstablished = false;
    }
    ctxId = nextCtxId;
    persistWorkspaceHint();
    return true;
  }

  function activateCtxId(value) {
    var assigned = assignCtxId(value);
    if (assigned && initialized) void startLive();
    return assigned;
  }

  function acceptToolResult(result) {
    if (!result) return false;
    var initial = asRecord(result.structuredContent);
    if (!initial || !initial.ctxId) return false;
    var assigned = assignCtxId(initial.ctxId);
    acceptMeta(result._meta, false);
    if (assigned && initialized) void startLive();
    return assigned;
  }

  function configureFromOpenAiGlobals(globals) {
    var source = globals || window.openai;
    var result = toolResultFromOpenAiGlobals(source);
    var configured = acceptToolResult(result);
    var hint = workspaceHintFromOpenAiGlobals(source);
    if (!configured && hint && hint.ctxId) configured = activateCtxId(hint.ctxId);
    if (
      !liveAuthorizationEstablished && hint && hint.ctxId && String(hint.ctxId) === ctxId &&
      typeof hint.token === "string" && hint.token
    ) {
      appToken = String(hint.token);
    }
    return configured || !!ctxId;
  }

  function modelContext(extra) {
    var tasks = snapshot && Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
    var background = snapshot && Array.isArray(snapshot.background) ? snapshot.background : [];
    var state = {
      ctxId: ctxId,
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
        kind: item.kind,
        result: item.result,
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

  async function requireModelContext(extra) {
    if (!initialized || !snapshot) throw new Error("Workspace state is unavailable for model re-entry");
    await app.updateModelContext(modelContext(extra));
  }

  async function sendModelMessage(text, extra, canSend, beforeSend) {
    await requireModelContext(extra);
    if (canSend && !canSend()) return false;
    if (beforeSend) await beforeSend();
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
    if (!goal || goal.status !== "active" || snapshot.agentBusy || visibleEvent() || busy.size > 0 || recovering) return false;
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
    var attempted = false;
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
        { goalContinuation: claim, continuationMessageId: claim && claim.goal && claim.goal.continuationMessageId },
        goalContinuationAvailable,
        async function () {
          var marked = structured(await callTool("workspace_goal_continue", {
            action: "attempt",
            claimId: claimId
          }, true));
          attempted = true;
          if (marked && marked.goal) snapshot.goal = marked.goal;
        }
      );
    } catch (error) {
      errorText = error instanceof Error ? error.message : String(error);
      console.error(error);
    } finally {
      if (claimed && !(attempted && !accepted && errorText)) {
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

  function reconcileTaskCancelConfirmations() {
    confirmingTaskCancel.forEach(function (revision, taskId) {
      var task = findTask(taskId);
      if (!task || task.revision !== revision) confirmingTaskCancel.delete(taskId);
    });
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
    var attempted = !!claimed.recoveryMessageAttemptedAt;
    var dispatched = false;
    try {
      dispatched = !!claimed.recoveryMessageSentAt;
      if (!dispatched) {
        dispatched = await sendModelMessage(
          message,
          Object.assign({}, extra || {}, {
            recoveredWait: claimed,
            recoveryMessageId: claimed.recoveryMessageId
          }),
          function () { return hasRecoverableWork(claimed); },
          async function () {
            await callTool("workspace_wait_recover", {
              action: "attempt",
              claimId: claimed.claimId,
              waitId: waitId
            }, true);
            attempted = true;
          }
        );
      }
      if (!dispatched) {
        await callTool("workspace_wait_recover", {
          action: "release",
          claimId: claimed.claimId,
          waitId: waitId
        }, true);
        return;
      }
      if (!claimed.recoveryMessageSentAt) {
        await callTool("workspace_wait_recover", {
          action: "sent",
          claimId: claimed.claimId,
          waitId: waitId
        }, true);
      }
      await callTool("workspace_wait_recover", {
        action: "complete",
        claimId: claimed.claimId,
        waitId: waitId
      }, true);
    } catch (error) {
      if (!dispatched && !attempted && claimed && claimed.claimId) {
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
      return entry.status === "resolved" && !!entry.detachedAt &&
        !(entry.recoveryMessageAttemptedAt && !entry.recoveryMessageSentAt) &&
        hasRecoverableWork(entry);
    });
    if (!item) return;
    recovering = true;
    try {
      await dispatchRecovery(
        item.waitId,
        RESUME_MESSAGE,
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
    reconcileTaskCancelConfirmations();
    persistWorkspaceHint();
    render();
    await syncModelContext();
    scheduleGoalContinuation(0);
    if (allowRecovery !== false) void recoverDetachedWait();
  }

  async function refresh(allowRecovery) {
    if (!initialized || !ctxId) return;
    try {
      var result = await callTool("workspace_snapshot", {}, true);
      await applySnapshot(structured(result), allowRecovery);
      status.textContent = "";
    } catch (error) {
      status.textContent = "Reconnecting";
      throw error;
    }
  }

  async function reconnectWorkspace() {
    if (!initialized || !ctxId) return;
    var result = await callTool("workspace_reconnect", {}, true);
    await applySnapshot(structured(result), true);
    status.textContent = "";
  }

  function workspaceAuthorizationFailed(error) {
    var message = error && error.message ? String(error.message) : String(error || "");
    return message.indexOf("Workspace App authorization is invalid") >= 0;
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
        var result = await callTool("workspace_watch", { cursor: cursor }, true, controller.signal);
        if (generation !== watchGeneration) return;
        var update = structured(result) || {};
        if (Number.isSafeInteger(update.cursor)) cursor = update.cursor;
        if (update.snapshot) {
          await applySnapshot(update.snapshot, true);
        }
        status.textContent = "";
      } catch (error) {
        if (generation !== watchGeneration || controller.signal.aborted) return;
        status.textContent = "Reconnecting";
        console.error(error);
        if (generation !== watchGeneration) return;
        if (workspaceAuthorizationFailed(error)) {
          watchStarted = false;
          status.textContent = "Reopen Workspace";
          return;
        } else {
          await sleep(1000);
          if (generation !== watchGeneration) return;
          try { await refresh(); } catch (_) {}
        }
      } finally {
        if (liveAbortController === controller) liveAbortController = null;
      }
    }
  }

  async function startLive() {
    if (!initialized || !ctxId || watchStarted) return;
    if (reconnectOnStart && !appToken) {
      status.textContent = "Waiting for Workspace authorization";
      return;
    }
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
    if (input && input.ctxId) activateCtxId(input.ctxId);
  };
  app.ontoolresult = acceptInitialOrLiveToolResult;
  app.ontoolcancelled = function () {
    status.textContent = "";
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
      status.textContent = "";
      var initialResult = await waitForInitialToolResult(300);
      if (initialResult) acceptToolResult(initialResult);
      else {
        reconnectOnStart = true;
        configureFromOpenAiGlobals();
      }
      if (!ctxId) {
        status.textContent = "Waiting for Workspace context";
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
      console.error(error);
      try {
        await refresh(false);
        status.textContent = "State changed; review and retry";
      } catch (_) {
        status.textContent = "Action failed";
      }
      return null;
    } finally {
      busy.delete(key);
      render();
    }
  }

  async function answerQuestion(waitId, answer) {
    var result = await act(waitId, "workspace_question_answer", { waitId: waitId, answer: answer });
    if (result && result.detached && hasRecoverableWork(result)) {
      try {
        await dispatchRecovery(
          result.waitId,
          RESUME_MESSAGE,
          { answeredQuestion: result }
        );
        await refresh(false);
      } catch (error) {
        console.error(error);
        await refresh(false).catch(function () {});
        status.textContent = "Resume available";
      }
    }
  }

  async function interruptWait(waitId) {
    var previousRecovering = recovering;
    recovering = true;
    var result;
    try {
      result = await act(waitId, "workspace_wait_interrupt", { waitId: waitId });
    } finally {
      recovering = previousRecovering;
    }
    if (result && result.interrupted && result.detached) await recoverDetachedWait();
  }

  function visibleEvent() {
    if (!snapshot) return null;
    var current = snapshot.currentEvent;
    if (current && typeof current === "object" && (current.kind === "question" || current.kind === "approval")) return current;
    var candidates = [];
    var questions = Array.isArray(snapshot.questions) ? snapshot.questions : [];
    questions.forEach(function (item) {
      candidates.push(Object.assign({ kind: "question" }, item));
    });
    var approvals = Array.isArray(snapshot.approvals) ? snapshot.approvals : [];
    approvals.forEach(function (item) {
      candidates.push(Object.assign({ kind: "approval" }, item));
    });
    candidates.sort(function (left, right) {
      var leftRank = left.kind === "question" && left.status === "detached" ? 1 : 0;
      var rightRank = right.kind === "question" && right.status === "detached" ? 1 : 0;
      if (leftRank !== rightRank) return leftRank - rightRank;
      return String(left.updatedAt || left.createdAt || "").localeCompare(String(right.updatedAt || right.createdAt || ""));
    });
    return candidates[0] || null;
  }

  function eventHead(label, badge) {
    return '<div class="card-head"><span class="event-name">' + escapeHtml(label) + '</span><span class="badge">' + escapeHtml(badge) + '</span></div>';
  }

  function questionCard(item) {
    var payload = item && item.payload && typeof item.payload === "object" ? item.payload : {};
    var choices = Array.isArray(payload.choices) ? payload.choices : [];
    var disabled = busy.has(item.waitId);
    var expanded = expandedQuestions.has(item.waitId);
    var shownChoices = expanded ? choices : choices.slice(0, 3);
    var rows = shownChoices.map(function (choice) {
      return '<button type="button" class="choice-row"' + (disabled ? ' disabled' : '') + ' data-question-choice="' + escapeHtml(item.waitId) + '" data-answer="' + escapeHtml(choice) + '"><span>' + escapeHtml(choice) + '</span><span class="muted" aria-hidden="true">›</span></button>';
    }).join("");
    if (!expanded && choices.length > shownChoices.length) {
      rows += '<button type="button" class="choice-row" data-question-expand="' + escapeHtml(item.waitId) + '" aria-expanded="false"><span>Show ' + (choices.length - shownChoices.length) + ' more</span><span class="muted" aria-hidden="true">+</span></button>';
    }
    var text = payload.allowText === false ? "" : '<div class="answer-row"><input aria-label="Answer" data-question-input="' + escapeHtml(item.waitId) + '" placeholder="Type an answer"' + (disabled ? ' disabled' : '') + '><button type="button" class="primary" data-question-submit="' + escapeHtml(item.waitId) + '"' + (disabled ? ' disabled' : '') + '>Send</button></div>';
    return '<div class="card">' + eventHead("Question", "Needs input") + '<div class="card-body"><div class="question">' + escapeHtml(payload.question || "Question") + '</div></div><div class="choice-list">' + rows + '</div>' + text + '</div>';
  }

  function approvalCard(item) {
    var disabled = busy.has(item.approvalId) ? " disabled" : "";
    var risk = item.riskLevel ? item.riskLevel.charAt(0).toUpperCase() + item.riskLevel.slice(1) + " risk" : "Review";
    var summary = item.inputSummary ? '<div class="mono detail">' + escapeHtml(item.inputSummary) + '</div>' : '';
    var reason = item.reason ? '<div class="detail"><div class="muted">Why</div><div>' + escapeHtml(item.reason) + '</div></div>' : '';
    return '<div class="card">' + eventHead("Approval", risk) + '<div class="card-body"><div class="question">Approval required</div>' + summary + reason + '<div class="row"><button class="danger" data-approval="' + escapeHtml(item.approvalId) + '" data-decision="deny"' + disabled + '>Deny</button><button class="primary" data-approval="' + escapeHtml(item.approvalId) + '" data-decision="approve"' + disabled + '>Approve</button></div></div></div>';
  }

  function tmuxWaitCard(item) {
    var key = item.waitId || item.taskId || item.tmuxTaskId;
    var disabled = busy.has(key);
    var action = '<button type="button" class="danger"' + (disabled ? ' disabled' : '') + ' data-wait-interrupt="' + escapeHtml(item.waitId) + '">Stop waiting</button>';
    return '<div class="card"><div class="background-row"><div class="background-copy"><div class="row"><span class="event-name">Background task</span><span class="badge">Running</span></div><div class="muted"><span>Waiting for task to finish</span><span> · task keeps running</span></div></div>' + action + '</div></div>';
  }

  function uncertainWaitCard(item) {
    var key = item.waitId || item.tmuxTaskId;
    var disabled = busy.has(key);
    var action = item.recoveryMessageId
      ? '<button type="button" class="action-row danger-row" aria-label="Dismiss automatic resume" data-wait-dismiss="' + escapeHtml(item.waitId) + '" data-recovery-message-id="' + escapeHtml(item.recoveryMessageId) + '"' + (disabled ? ' disabled' : '') + '><span>Dismiss automatic resume</span><span class="muted">continue manually in chat</span></button>'
      : '';
    return '<div class="card">' + eventHead("Resume", "Delivery uncertain") + '<div class="card-body"><div class="question">Automatic retry stopped to avoid duplicate agent execution.</div><div class="muted">The previous resume message may have been accepted by the host. Continue manually in chat, then dismiss this automatic resume.</div></div>' + action + '</div>';
  }

  function backgroundWaitCards() {
    var background = Array.isArray(snapshot && snapshot.background) ? snapshot.background : [];
    var waiting = background.filter(function (item) { return (item.kind === "tmux" || item.tmuxTaskId) && (item.status === "waiting" || item.status === "detached"); });
    var uncertain = background.filter(function (item) {
      return item.status === "resolved" && item.recoveryMessageAttemptedAt && !item.recoveryMessageSentAt;
    });
    return waiting.map(tmuxWaitCard).join("") + uncertain.map(uncertainWaitCard).join("");
  }

  function taskCard(task) {
    var key = "task:" + task.taskId;
    var disabled = busy.has(key) ? " disabled" : "";
    var progress = '<div class="muted">' + escapeHtml(task.completed) + '/' + escapeHtml(task.total) + ' items</div>';
    var current = task.currentItem ? '<div class="goal-current"><div class="muted">Current</div><div>' + escapeHtml(task.currentItem) + '</div></div>' : '';
    var checkpoint = task.checkpoint && task.checkpoint.summary ? '<div class="detail"><div class="muted">Checkpoint</div><div>' + escapeHtml(task.checkpoint.summary) + '</div></div>' : '';
    var action = task.status === "paused" ? "resume" : "pause";
    var actionLabel = task.status === "paused" ? "Resume task" : "Pause task";
    var cancelPending = confirmingTaskCancel.get(task.taskId) === task.revision;
    var cancelLabel = cancelPending ? "Confirm cancel" : "Cancel task";
    var cancelDetail = cancelPending ? "click again · processes keep running" : "keep processes running";
    var controls = '<button type="button" class="action-row" aria-label="' + actionLabel + '" data-task-control="' + action + '" data-task-id="' + escapeHtml(task.taskId) + '" data-task-revision="' + escapeHtml(task.revision) + '"' + disabled + '><span>' + actionLabel + '</span><span class="muted">model re-entry only</span></button>' +
      '<button type="button" class="action-row danger-row" aria-label="' + cancelLabel + '" data-task-control="cancel" data-task-id="' + escapeHtml(task.taskId) + '" data-task-revision="' + escapeHtml(task.revision) + '"' + disabled + '><span>' + cancelLabel + '</span><span class="muted">' + cancelDetail + '</span></button>';
    var label = task.status === "paused" ? "Paused" : "Running";
    return '<div class="card">' + eventHead("Task · " + task.title, label) + '<div class="card-body">' + progress + current + checkpoint + '</div>' + controls + '</div>';
  }

  function taskCards() {
    var tasks = snapshot && Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
    return tasks.filter(function (task) {
      return task.status !== "completed" && task.status !== "cancelled" && task.status !== "none";
    }).map(taskCard).join("");
  }

  function goalCard() {
    var goal = snapshot && snapshot.goal;
    if (!goal || goal.status === "completed" || goal.status === "stopped") return "";
    var steps = Array.isArray(goal.steps) ? goal.steps : [];
    var completed = steps.filter(function (step) { return step.status === "completed" || step.status === "skipped"; }).length;
    var current = steps.find(function (step) { return step.status === "active"; }) || steps.find(function (step) { return step.status === "pending"; });
    var progress = '<div class="muted">' + completed + '/' + steps.length + ' steps</div>';
    var currentStep = current ? '<div class="goal-current"><div class="muted">' + (current.status === "active" ? 'Current' : 'Next') + '</div><div>' + escapeHtml(current.text) + '</div>' + (current.note ? '<div class="muted detail">' + escapeHtml(current.note) + '</div>' : '') + '</div>' : '';
    var note = goal.status === "blocked" && goal.note ? '<div class="goal-note"><div class="muted">Reason</div><div>' + escapeHtml(goal.note) + '</div></div>' : '';
    var uncertain = goal.continuationUncertain ? '<div class="goal-note"><div class="muted">Continuation delivery uncertain</div><div>Automatic retry stopped to avoid duplicate agent execution. Continue manually in chat or stop this Goal.</div></div>' : '';
    var actions = "";
    if (goal.status === "blocked") {
      actions += '<button type="button" class="action-row" aria-label="Resume Goal" data-goal-resume="' + escapeHtml(goal.goalId) + '" data-goal-revision="' + escapeHtml(goal.revision) + '"' + (busy.has("goal-resume") ? ' disabled' : '') + '><span>Resume Goal</span><span class="muted">continue agent work</span></button>';
    }
    actions += '<button type="button" class="action-row danger-row" aria-label="Stop Goal" data-goal-stop="' + escapeHtml(goal.goalId) + '" data-goal-revision="' + escapeHtml(goal.revision) + '"' + (busy.has("goal-stop") ? ' disabled' : '') + '><span>Stop Goal</span><span class="muted">keep processes running</span></button>';
    var statusLabel = goal.continuationUncertain ? "Delivery uncertain" : goal.status === "blocked" ? "Blocked" : "Active";
    return '<div class="card">' + eventHead("Goal", statusLabel) + '<div class="card-body"><div class="question">' + escapeHtml(goal.objective) + '</div>' + progress + currentStep + note + uncertain + '</div>' + actions + '</div>';
  }

  function render() {
    if (!snapshot) return;
    var item = visibleEvent();
    var eventCard = !item ? ""
      : item.kind === "question" ? questionCard(item)
      : item.kind === "approval" ? approvalCard(item)
      : "";
    root.innerHTML = eventCard + goalCard() + (item ? "" : taskCards()) + backgroundWaitCards();
  }

  root.addEventListener("click", function (event) {
    var goalResume = event.target.closest("[data-goal-resume]");
    if (goalResume && !goalResume.hasAttribute("disabled")) {
      void act("goal-resume", "workspace_goal_resume", {
        goalId: goalResume.getAttribute("data-goal-resume"),
        revision: Number(goalResume.getAttribute("data-goal-revision"))
      });
      return;
    }
    var goalStop = event.target.closest("[data-goal-stop]");
    if (goalStop && !goalStop.hasAttribute("disabled")) {
      void act("goal-stop", "workspace_goal_stop", {
        goalId: goalStop.getAttribute("data-goal-stop"),
        revision: Number(goalStop.getAttribute("data-goal-revision"))
      });
      return;
    }
    var waitDismiss = event.target.closest("[data-wait-dismiss]");
    if (waitDismiss && !waitDismiss.hasAttribute("disabled")) {
      var dismissWaitId = waitDismiss.getAttribute("data-wait-dismiss");
      var recoveryMessageId = waitDismiss.getAttribute("data-recovery-message-id");
      if (dismissWaitId && recoveryMessageId) void act(dismissWaitId, "workspace_wait_recover", {
        action: "dismiss",
        recoveryMessageId: recoveryMessageId,
        waitId: dismissWaitId
      });
      return;
    }
    var taskControl = event.target.closest("[data-task-control]");
    if (taskControl && !taskControl.hasAttribute("disabled")) {
      var taskId = taskControl.getAttribute("data-task-id");
      var taskAction = taskControl.getAttribute("data-task-control");
      var taskRevision = Number(taskControl.getAttribute("data-task-revision"));
      if (taskId && taskAction === "cancel" && confirmingTaskCancel.get(taskId) !== taskRevision) {
        confirmingTaskCancel.set(taskId, taskRevision);
        render();
        return;
      }
      if (taskId && taskAction) {
        confirmingTaskCancel.delete(taskId);
        void act("task:" + taskId, "workspace_task_control", {
          action: taskAction,
          revision: Number(taskControl.getAttribute("data-task-revision")),
          taskId: taskId
        });
      }
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
    var submit = event.target.closest("[data-question-submit]");
    if (submit && !submit.hasAttribute("disabled")) {
      var answerInput = submit.parentElement && submit.parentElement.querySelector("[data-question-input]");
      var answer = answerInput ? answerInput.value.trim() : "";
      var questionWaitId = submit.getAttribute("data-question-submit");
      if (answer && questionWaitId) void answerQuestion(questionWaitId, answer);
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
      void interruptWait(waitId);
      return;
    }
  });

  root.addEventListener("keydown", function (event) {
    var input = event.target.closest && event.target.closest("[data-question-input]");
    if (input && event.key === "Enter" && !event.isComposing) {
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

const workspaceAppDigest = createHash("sha256")
    .update(workspaceAppHtml)
    .digest("hex")
    .slice(0, 16);
export const workspaceAppResourceUri = `ui://portable-devshell/workspace-${workspaceAppDigest}.html`;
export const workspaceAppResourceUris = [
    workspaceAppResourceUri,
    workspaceAppStableResourceUri,
    ...workspaceAppLegacyResourceUris,
] as const;

function loadWorkspaceSdkScript(): string {
    const path = fileURLToPath(
        import.meta.resolve("@modelcontextprotocol/ext-apps/app-with-deps"),
    );
    const source = readFileSync(path, "utf8").trimEnd();
    const exportBlock = source.match(/export\{([\s\S]+)\};$/);
    const exports = exportBlock?.[1];
    const exportedSymbol = (name: string): string | undefined => {
        const match = exports?.match(
            new RegExp(
                `(?:^|,)\\s*([$A-Za-z_][$\\w]*)\\s+as\\s+${name}\\s*(?:,|$)`,
            ),
        );
        return match?.[1];
    };
    const appExport = exportedSymbol("App");
    const applyDocumentThemeExport = exportedSymbol("applyDocumentTheme");
    const applyHostStyleVariablesExport = exportedSymbol(
        "applyHostStyleVariables",
    );
    const applyHostFontsExport = exportedSymbol("applyHostFonts");
    if (
        exportBlock?.index === undefined ||
        appExport === undefined ||
        applyDocumentThemeExport === undefined ||
        applyHostStyleVariablesExport === undefined ||
        applyHostFontsExport === undefined
    ) {
        throw new Error(
            "Unable to locate required exports in @modelcontextprotocol/ext-apps/app-with-deps.",
        );
    }
    if (source.toLowerCase().includes("</script")) {
        throw new Error(
            "MCP Apps browser bundle cannot be embedded safely in Workspace HTML.",
        );
    }
    return (
        `${source.slice(0, exportBlock.index)}globalThis.__portableDevshellMcpApps={` +
        `App:${appExport},` +
        `applyDocumentTheme:${applyDocumentThemeExport},` +
        `applyHostFonts:${applyHostFontsExport},` +
        `applyHostStyleVariables:${applyHostStyleVariablesExport}` +
        `};`
    );
}
