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
        "Persistent portable-devshell Live Workspace for goals, tasks, approvals, questions, and background work.",
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
            csp: { connectDomains: [domain], resourceDomains: [] },
            domain,
        },
        "openai/widgetCSP": { connect_domains: [domain], resource_domains: [] },
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
  var app = new App(
    { name: "portable-devshell-workspace", version: "0.6.8" },
    { availableDisplayModes: ["inline", "pip", "fullscreen"] },
    { autoResize: false }
  );
  var ctxId = "";
  var appToken = "";
  var liveBaseUrl = "";
  var liveTransportRetryAt = 0;
  var liveAuthorizationEstablished = false;
  var initialized = false;
  var snapshot = null;
  var cursor = 0;
  var snapshotRequestSerial = 0;
  var lastAppliedSnapshotSerial = 0;
  var watchGeneration = 0;
  var watchStarted = false;
  var reconnectOnStart = false;
  var recovering = false;
  var busy = new Set();
  var confirmingTaskCancel = new Map();
  var expandedQuestions = new Set();
  var WIDGET_STATE_KEY = "portableDevshellWorkspace";
  var HOST_CONNECT_TIMEOUT_MS = 3000;
  var HOST_REQUEST_TIMEOUT_MS = 5000;
  var APP_TOOL_TIMEOUT_MS = 30000;
  var LIVE_START_RETRY_MS = 1000;
  var LIVE_SNAPSHOT_TIMEOUT_MS = 5000;
  var LIVE_WATCH_TIMEOUT_MS = 30000;
  var LIVE_TRANSPORT_BACKOFF_MS = 30000;
  var DISPLAY_MODE_TIMEOUT_MS = 1000;
  var DISPLAY_MODE_RETRY_MS = 750;
  var DISPLAY_MODE_MAX_RETRIES = 2;
  var RECOVERY_MESSAGE_SUFFIX = " THIS IS A WORK RESUMPTION EVENT, NOT A CHAT MESSAGE. Do not reply with an acknowledgement, plan, status update, or a statement that you will continue. Immediately read the current Workspace state and the triggering result, then execute the next required action in this same turn. Do not repeat completed work or restart an existing tmux task. If the result is still required and an existing task is still running, re-enter a real blocking wait on that task instead of ending the turn. If a blocked Workspace Goal can now proceed, call workspace_goal with action=resume and continue executing it. You may end the turn only after the Goal is finished, progress genuinely requires user input and the Goal is blocked, or you have entered a real blocking wait.";
  var bridgeReady = false;
  var pendingToolResult = null;
  var initialToolResultResolve = null;
  var liveAbortController = null;
  var goalTimer = null;
  var goalContinuationClaimId = "";
  var automaticMessageInFlight = false;
  var heldReentryClaimId = "";
  var hostBridgeGeneration = 0;
  var modelContextEpoch = 0;
  var modelContextSyncController = null;
  var modelContextUpdateTail = Promise.resolve();
  var sizeChangedCleanup = null;
  var connectRetryTimer = null;
  var liveStartRetryTimer = null;
  var displayModeRetryTimer = null;
  var displayModeRetryCount = 0;
  var presentationGeneration = 0;
  var displayModeRequestGeneration = 0;
  var presentationClaimPending = false;
  var bridgeConnecting = false;
  var bridgeResetting = false;
  var shuttingDown = false;

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  }

  function callTool(name, args, requiresToken, signal) {
    if (!initialized) return Promise.reject(new Error("Workspace App is not initialized"));
    if (requiresToken && !appToken) return Promise.reject(new Error("Workspace App authorization is unavailable"));
    if (!ctxId) return Promise.reject(new Error("Workspace context is unavailable"));
    var requestCtxId = ctxId;
    var requestToken = appToken;
    var requestLiveBaseUrl = liveBaseUrl;
    var input = Object.assign({}, args || {});
    input.ctxId = requestCtxId;
    if (requiresToken) input.token = requestToken;
    var options = { timeout: APP_TOOL_TIMEOUT_MS };
    if (signal) options.signal = signal;
    return app.callServerTool(
      { name: name, arguments: input },
      options
    ).then(function (result) {
      if (ctxId !== requestCtxId || appToken !== requestToken || liveBaseUrl !== requestLiveBaseUrl) {
        throw new Error("Workspace Context changed while the request was in flight");
      }
      acceptMeta(result && result._meta, true);
      return result;
    }).catch(function (error) {
      if (!(signal && signal.aborted) && hostBridgeTransportFailure(error)) void resetHostBridge();
      throw error;
    });
  }

  function structured(result) {
    return result && result.structuredContent ? result.structuredContent : result;
  }

  async function callLive(path, signal, timeoutMs) {
    if (!liveBaseUrl || !appToken || !ctxId) throw new Error("Live Workspace transport is unavailable");
    var requestCtxId = ctxId;
    var requestToken = appToken;
    var requestLiveBaseUrl = liveBaseUrl;
    var separator = path.indexOf("?") >= 0 ? "&" : "?";
    var response;
    var requestController = new AbortController();
    var timedOut = false;
    var timer = setTimeout(function () {
      timedOut = true;
      requestController.abort("Live Workspace request timed out");
    }, timeoutMs);
    function abortFromCaller() {
      requestController.abort(signal && signal.reason);
    }
    if (signal) {
      if (signal.aborted) abortFromCaller();
      else signal.addEventListener("abort", abortFromCaller, { once: true });
    }
    try {
      response = await fetch(
        requestLiveBaseUrl + path + separator + "ctxId=" + encodeURIComponent(requestCtxId),
        {
          cache: "no-store",
          credentials: "omit",
          headers: { Authorization: "Bearer " + requestToken },
          signal: requestController.signal
        }
      );
    } catch (error) {
      if (signal && signal.aborted) throw error;
      var unavailable = new Error("Live Workspace transport is unavailable");
      if (timedOut) unavailable.message = "Live Workspace transport timed out";
      unavailable.cause = error;
      throw unavailable;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", abortFromCaller);
    }
    if (ctxId !== requestCtxId || appToken !== requestToken || liveBaseUrl !== requestLiveBaseUrl) {
      throw new Error("Live Workspace request became stale");
    }
    if (!response.ok) {
      var responseError = "";
      try {
        var errorBody = await response.json();
        responseError = errorBody && errorBody.error ? String(errorBody.error) : "";
      } catch (_) {}
      if (response.status === 401 || response.status === 403) {
        if (workspaceContextExpired(responseError) || workspaceContextDisabled(responseError)) {
          throw new Error(responseError);
        }
        throw new Error("Live Workspace transport rejected authorization");
      }
      throw new Error("Live Workspace transport failed with HTTP " + response.status);
    }
    var value = await response.json();
    if (ctxId !== requestCtxId || appToken !== requestToken || liveBaseUrl !== requestLiveBaseUrl) {
      throw new Error("Live Workspace request became stale");
    }
    liveAuthorizationEstablished = true;
    liveTransportRetryAt = 0;
    return value;
  }

  function directLiveAvailable() {
    return !!liveBaseUrl && Date.now() >= liveTransportRetryAt;
  }

  function suppressLiveTransport() {
    liveTransportRetryAt = Date.now() + LIVE_TRANSPORT_BACKOFF_MS;
  }

  function setLiveBaseUrl(value) {
    var next = value ? String(value).replace(/\/$/, "") : "";
    if (next !== liveBaseUrl) liveTransportRetryAt = 0;
    liveBaseUrl = next;
  }

  async function readLiveSnapshot(signal) {
    return await callLive("/snapshot", signal, LIVE_SNAPSHOT_TIMEOUT_MS);
  }

  async function readLiveWatch(signal) {
    return await callLive("/watch?cursor=" + encodeURIComponent(String(cursor)), signal, LIVE_WATCH_TIMEOUT_MS);
  }

  function acceptMeta(meta, authoritative) {
    var hidden = meta && meta["portable-devshell/workspace"];
    if (!hidden || !hidden.token) return;
    if (liveAuthorizationEstablished && authoritative !== true) return;
    appToken = String(hidden.token);
    if (typeof hidden.liveBaseUrl === "string" && hidden.liveBaseUrl) {
      setLiveBaseUrl(hidden.liveBaseUrl);
    } else if (authoritative === true) {
      setLiveBaseUrl("");
    }
    if (authoritative === true) liveAuthorizationEstablished = true;
    persistWorkspaceHint();
  }

  function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  }

  function recoveryMessage(item) {
    var result = asRecord(item && item.result) || {};
    var task = asRecord(result.task) || {};
    var taskId = String((item && item.targetId) || task.id || "the existing tmux task");
    if (item && item.kind === "question") {
      var answer = typeof result.answer === "string" ? result.answer : "";
      if (answer.length > 500) answer = answer.slice(0, 500) + "…";
      return "Workspace wake event: the user answered the pending Workspace question" +
        (answer ? " with " + JSON.stringify(answer) : "") + "." + RECOVERY_MESSAGE_SUFFIX;
    }
    if (item && item.kind === "tmux") {
      if (result.interrupted === true) {
        return "Workspace wake event: the user stopped waiting for tmux task " + taskId +
          "; the wait ended, but the tmux task was not stopped." + RECOVERY_MESSAGE_SUFFIX;
      }
      if (result.waitReason === "output") {
        return "Workspace wake event: tmux task " + taskId +
          " has unread output ready. Read the retained transcript with tmux_read before continuing." + RECOVERY_MESSAGE_SUFFIX;
      }
      if (result.waitReason === "timeout") {
        return "Workspace wake event: the tmux_read wait interval elapsed for task " + taskId +
          ". Read the task once with tmux_read(timeMs=0), then decide whether another blocking read is required." + RECOVERY_MESSAGE_SUFFIX;
      }
      if (result.timedOut === true) {
        return "Workspace wake event: wait deadline elapsed for tmux task " + taskId +
          "; the task is still running." + RECOVERY_MESSAGE_SUFFIX;
      }
      if (task.status !== undefined && String(task.status) !== "running") {
        return "Workspace wake event: tmux task " + taskId + " finished while detached with status " +
          String(task.status) + ". Read its retained transcript/result before continuing." + RECOVERY_MESSAGE_SUFFIX;
      }
      return "Workspace wake event: the detached wait for tmux task " + taskId + " resolved." + RECOVERY_MESSAGE_SUFFIX;
    }
    return "Workspace wake event: a detached Workspace wait resolved." + RECOVERY_MESSAGE_SUFFIX;
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
    var retainedLiveBaseUrl = !liveAuthorizationEstablished && !liveBaseUrl && previousHint && String(previousHint.ctxId || "") === ctxId &&
      typeof previousHint.liveBaseUrl === "string" && previousHint.liveBaseUrl
        ? String(previousHint.liveBaseUrl)
        : "";
    var persistedLiveBaseUrl = liveBaseUrl || retainedLiveBaseUrl;
    privateContent[WIDGET_STATE_KEY] = Object.assign(
      { ctxId: ctxId },
      persistedToken ? { token: persistedToken } : {},
      persistedLiveBaseUrl ? { liveBaseUrl: persistedLiveBaseUrl } : {}
    );
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
      if (liveAbortController) liveAbortController.abort();
      liveAbortController = null;
      watchStarted = false;
      snapshot = null;
      cursor = 0;
      appToken = "";
      setLiveBaseUrl("");
      liveAuthorizationEstablished = false;
    }
    ctxId = nextCtxId;
    persistWorkspaceHint();
    return true;
  }

  function activateCtxId(value) {
    var assigned = assignCtxId(value);
    if (assigned && initialized) void ensureLiveStarted();
    return assigned;
  }

  function acceptToolResult(result) {
    if (!result) return false;
    var initial = asRecord(result.structuredContent);
    if (!initial || !initial.ctxId) return false;
    var assigned = assignCtxId(initial.ctxId);
    acceptMeta(result._meta, false);
    if (assigned && initialized) void ensureLiveStarted();
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
    if (
      !liveAuthorizationEstablished && hint && hint.ctxId && String(hint.ctxId) === ctxId &&
      typeof hint.liveBaseUrl === "string" && hint.liveBaseUrl
    ) {
      setLiveBaseUrl(hint.liveBaseUrl);
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
    if (!initialized || !snapshot || automaticMessageInFlight) return;
    var epoch = modelContextEpoch;
    var controller = new AbortController();
    modelContextSyncController = controller;
    try {
      await updateHostModelContext(modelContext(extra), {
        ordinaryEpoch: epoch,
        signal: controller.signal
      });
    } catch (error) {
      if (!controller.signal.aborted && hostBridgeTransportFailure(error)) void resetHostBridge();
    } finally {
      if (modelContextSyncController === controller) modelContextSyncController = null;
    }
  }

  async function requireModelContext(extra) {
    if (!initialized || !snapshot) throw new Error("Workspace state is unavailable for model re-entry");
    await updateHostModelContext(modelContext(extra));
  }

  async function updateHostModelContext(value, options) {
    var generation = hostBridgeGeneration;
    var operation = modelContextUpdateTail.then(async function () {
      if (options && Number.isSafeInteger(options.ordinaryEpoch) && options.ordinaryEpoch !== modelContextEpoch) return;
      if (generation !== hostBridgeGeneration || !initialized || !bridgeReady) {
        throw new Error("Host bridge changed before model context delivery");
      }
      var requestOptions = { timeout: HOST_REQUEST_TIMEOUT_MS };
      if (options && options.signal) requestOptions.signal = options.signal;
      return await app.updateModelContext(value, requestOptions);
    });
    modelContextUpdateTail = operation.then(function () {}, function () {});
    return await operation;
  }

  async function sendHostMessage(value) {
    return await app.sendMessage(value, { timeout: HOST_REQUEST_TIMEOUT_MS });
  }

  function newReentryClaimId() {
    if (crypto && typeof crypto.randomUUID === "function") return "workspace-reentry-" + crypto.randomUUID();
    return "workspace-reentry-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
  }

  function automaticReentryAvailable() {
    if (!initialized || !bridgeReady || bridgeResetting || shuttingDown) return false;
    var reentry = snapshot && snapshot.reentry;
    if (!reentry) return true;
    if (reentry.suppressedAt) return false;
    if (reentry.pending && (!heldReentryClaimId || reentry.claimId !== heldReentryClaimId)) return false;
    return true;
  }

  async function releaseAutomaticMessage(claimId) {
    if (!claimId) return;
    try {
      var released = structured(await callTool("workspace_reentry_control", {
        action: "release",
        claimId: claimId
      }, true));
      if (snapshot && released) snapshot.reentry = released;
    } catch (error) {
      console.error(error);
    } finally {
      if (heldReentryClaimId === claimId) heldReentryClaimId = "";
    }
  }

  async function settleAutomaticMessageClaim(outcome) {
    if (!outcome || !outcome.claimId) return;
    if (outcome.status === "accepted" || outcome.status === "uncertain") {
      if (heldReentryClaimId === outcome.claimId) heldReentryClaimId = "";
      return;
    }
    await releaseAutomaticMessage(outcome.claimId);
  }

  async function sendModelMessage(text, extra, canSend, beforeSend) {
    if (automaticMessageInFlight || !automaticReentryAvailable() || (canSend && !canSend())) {
      return { status: "blocked" };
    }
    automaticMessageInFlight = true;
    modelContextEpoch += 1;
    if (modelContextSyncController) modelContextSyncController.abort("automatic model re-entry");
    var claimId = newReentryClaimId();
    var messageDispatched = false;
    try {
      var arbitration = structured(await callTool("workspace_reentry_control", {
        action: "claim",
        claimId: claimId
      }, true));
      if (snapshot && arbitration) snapshot.reentry = arbitration;
      if (!arbitration || !arbitration.claimed) return { status: "blocked" };
      heldReentryClaimId = claimId;
      if (!automaticReentryAvailable() || (canSend && !canSend())) {
        return { claimId: claimId, status: "blocked" };
      }
      if (beforeSend) {
        var prepared = await beforeSend();
        if (prepared === false) return { claimId: claimId, status: "blocked" };
      }
      if (!automaticReentryAvailable() || (canSend && !canSend())) {
        return { claimId: claimId, status: "blocked" };
      }
      var validation = structured(await callTool("workspace_reentry_control", {
        action: "validate",
        claimId: claimId
      }, true));
      if (snapshot && validation) snapshot.reentry = validation;
      if (!validation || !validation.valid || !automaticReentryAvailable() || (canSend && !canSend())) {
        return { claimId: claimId, status: "blocked" };
      }

      // Keep the recovery-specific context adjacent to the message it belongs to.
      // After this await there are no further asynchronous checks before dispatch.
      await requireModelContext(extra);
      if (!automaticReentryAvailable() || (canSend && !canSend())) {
        return { claimId: claimId, status: "blocked" };
      }
      messageDispatched = true;
      var result = await sendHostMessage({
        role: "user",
        content: [{ type: "text", text: text }]
      });
      return { claimId: claimId, status: result && result.isError ? "rejected" : "accepted" };
    } catch (error) {
      console.error(error);
      return {
        bridgeFailure: hostBridgeTransportFailure(error),
        claimId: heldReentryClaimId === claimId ? claimId : undefined,
        error: error instanceof Error ? error.message : String(error),
        status: messageDispatched ? "uncertain" : "blocked"
      };
    } finally {
      automaticMessageInFlight = false;
    }
  }

  function newGoalContinuationClaimId() {
    if (crypto && typeof crypto.randomUUID === "function") return "goal-continue-" + crypto.randomUUID();
    return "goal-continue-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
  }

  function goalContinuationMessage(claim) {
    var goal = claim && claim.goal;
    var steps = goal && Array.isArray(goal.steps) ? goal.steps : [];
    var readyToFinish = steps.length > 0 && steps.every(function (step) {
      return step && (step.status === "completed" || step.status === "skipped");
    });
    var attempt = claim && Number.isFinite(claim.continuationCount)
      ? Math.max(1, Math.floor(claim.continuationCount))
      : Math.max(1, ((goal && goal.continuationCount) || 0) + 1);
    var index = Math.min(attempt - 1, 9);
    var workLeads = [
      "你是不是把这条唤醒当成普通聊天消息了？Goal 还 active，而且没有任何可见推进。",
      "上一次已经提醒过了，但 Goal 状态还是没动。你可能又只回复了‘继续’或做了文字汇报。",
      "连续两次唤醒后还没有任何推进，这已经很像在磨洋工了。不要再拿一句‘继续执行’顶过去。",
      "还在磨洋工？Goal 没有自己往前走，你需要真的执行当前 step。",
      "第五次了，你他妈要是又只回一句‘继续执行’就结束，那就是明摆着在糊弄。",
      "已经反复催了六次还不推进，别他妈磨了。现在做实际工具调用。",
      "第七次还让 Goal 原地不动，你是在等谁替你干？直接执行。",
      "八次唤醒还没推进，你他妈到底准备磨到什么时候？要么执行，要么进入真实 wait/block。",
      "第九次了还在磨洋工。别再输出任何状态说明，直接把当前 step 做掉。",
      "最后一次提醒：再拿‘继续执行’这种空话糊弄而不产生实际动作，就是彻底的执行失败。现在立刻干活。"
    ];
    var finishLeads = [
      "所有 step 都已经完成了，剩下的是显式结束 Goal。",
      "当前没有待执行 step；请完成 Goal 的最终状态提交。",
      "steps 已全部 completed/skipped，现在只需要结束 Goal 本身。",
      "执行内容已经收口，但 durable Goal 仍是 active，需要显式 finish。",
      "当前是纯收尾状态：没有业务步骤剩余，只差 workspace_goal(action=\"finish\")。",
      "Goal 的工作项都已终态；请把 Goal 状态从 active 正式结束。",
      "这里不需要继续执行任务，只需要提交 Goal finish。",
      "当前步骤已经全部结束，请完成 Workspace Goal 的最终 finish。",
      "没有剩余工作项；请显式调用 finish 完成状态机收口。",
      "这是 Goal 的最终收尾提醒：直接调用 workspace_goal(action=\"finish\")。"
    ];
    if (readyToFinish) {
      return finishLeads[index] + " 这是第 " + attempt + " 次唤醒。所有 step 已经 completed/skipped，但 Goal 仍然 active。不要回复确认、解释、状态汇报，也不要再说‘当前已经完成’。你的第一动作必须是调用 workspace_goal(action=\"finish\")；不要先 update，不要先输出一句话。只有 finish 成功后才允许结束本回合。只输出文字而不调用 finish，仍然算恢复失败。";
    }
    return workLeads[index] + " 这是第 " + attempt + " 次唤醒。Goal 仍有 pending/active step，而且没有 blocking wait、background task、approval 或 user question 阻止你工作。不要回复确认、道歉、计划、状态汇报或‘继续执行’。立即读取当前 Goal 并实际执行下一步，完成后用 workspace_goal(action=\"update\") 同步状态。只有进入真实 blocking wait、确实需要用户输入并 block Goal，或者所有 step 终态后显式调用 workspace_goal(action=\"finish\")，才允许结束本回合。只描述你准备做什么而不执行，仍然算恢复失败。";
  }

  async function yieldAutomaticReentry(reason) {
    if (goalTimer) clearTimeout(goalTimer);
    goalTimer = null;
    try {
      var yielded = structured(await callTool("workspace_reentry_control", {
        action: "yield",
        reason: reason || "user interrupted automatic execution"
      }, true));
      if (snapshot && yielded) snapshot.reentry = yielded;
      heldReentryClaimId = "";
      render();
    } catch (error) {
      console.error(error);
    }
  }

  function userCancelledTool(params) {
    var reason = params && params.reason ? String(params.reason).toLowerCase() : "";
    return reason.indexOf("user") >= 0 || reason.indexOf("stop") >= 0;
  }

  function goalContinuationAvailable() {
    var goal = snapshot && snapshot.goal;
    if (!goal || goal.status !== "active" || !automaticReentryAvailable() || snapshot.agentBusy || visibleEvent() || busy.size > 0 || recovering) return false;
    var background = Array.isArray(snapshot.background) ? snapshot.background : [];
    return !background.some(function (item) {
      return item && item.goalId === goal.goalId && item.automaticRecovery !== false && !item.recoveryDisabledAt &&
        item.status !== "consumed" && item.status !== "cancelled";
    });
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
    if (!goal || goal.status !== "active" || goal.autoContinueExhausted || goal.continuationPending || automaticMessageInFlight || !goalContinuationAvailable()) return;
    var claimId = goalContinuationClaimId || newGoalContinuationClaimId();
    goalContinuationClaimId = claimId;
    var attempted = false;
    var errorText = "";
    var claimed = false;
    var outcome = { status: "blocked" };
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
      outcome = await sendModelMessage(
        goalContinuationMessage(claim),
        { goalContinuation: claim, continuationMessageId: claim && claim.goal && claim.goal.continuationMessageId },
        goalContinuationAvailable,
        async function () {
          var marked = structured(await callTool("workspace_goal_continue", {
            action: "attempt",
            available: goalContinuationAvailable(),
            claimId: claimId
          }, true));
          if (marked && marked.goal) snapshot.goal = marked.goal;
          if (!marked || marked.attempted === false) return false;
          attempted = true;
          return true;
        }
      );
      if (outcome.status === "rejected") errorText = "Host rejected the Workspace continuation message.";
      if (outcome.error) errorText = outcome.error;
    } catch (error) {
      errorText = error instanceof Error ? error.message : String(error);
      console.error(error);
    } finally {
      var uncertain = outcome && outcome.status === "uncertain";
      if (claimed && !uncertain) {
        try {
          var reportArgs = { accepted: outcome && outcome.status === "accepted", action: "report", claimId: claimId };
          if (errorText) reportArgs.error = errorText;
          var report = structured(await callTool("workspace_goal_continue", reportArgs, true));
          if (report && report.goal) snapshot.goal = report.goal;
        } catch (reportError) {
          console.error(reportError);
        }
      }
      await settleAutomaticMessageClaim(outcome);
      goalContinuationClaimId = "";
      render();
      scheduleGoalContinuation(0);
      if (outcome && outcome.bridgeFailure) await resetHostBridge();
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
    var explicitHumanResume = item.kind === "question" || (item.result && item.result.interrupted === true);
    if (item.recoveryDisabledAt || (item.automaticRecovery === false && !explicitHumanResume)) return false;
    if (item.goalId) {
      var goal = snapshot && snapshot.goal;
      if (!goal || goal.goalId !== item.goalId) return false;
      var explicitHumanResume = item.kind === "question" || (item.result && item.result.interrupted === true);
      if (goal.status !== "active" && !(goal.status === "blocked" && explicitHumanResume)) return false;
      if (item.goalStepId) {
        return !!(Array.isArray(goal.steps) && goal.steps.some(function (step) {
          return step.id === item.goalStepId && step.status === "active";
        }));
      }
      return true;
    }
    if (!item.taskId) return true;
    var task = findTask(item.taskId);
    return !!task && task.status === "in_progress";
  }

  async function dispatchRecovery(waitId, extra) {
    var claimed = structured(await callTool("workspace_wait_recover", { action: "claim", waitId: waitId }, true));
    var attempted = !!claimed.recoveryMessageAttemptedAt;
    var outcome = { status: claimed.recoveryMessageSentAt ? "accepted" : "blocked" };
    try {
      if (!claimed.recoveryMessageSentAt) {
        outcome = await sendModelMessage(
          recoveryMessage(claimed),
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
            return true;
          }
        );
      }
      if (outcome.status === "uncertain") return;
      if (outcome.status === "rejected" || outcome.status === "blocked") {
        await callTool("workspace_wait_recover", {
          action: attempted ? "reject" : "release",
          claimId: claimed.claimId,
          waitId: waitId
        }, true).catch(function () {});
        await settleAutomaticMessageClaim(outcome);
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
      await settleAutomaticMessageClaim(outcome);
    } catch (error) {
      if (!attempted && claimed && claimed.claimId) {
        await callTool("workspace_wait_recover", {
          action: "release",
          claimId: claimed.claimId,
          waitId: waitId
        }, true).catch(function () {});
      }
      await settleAutomaticMessageClaim(outcome);
      throw error;
    } finally {
      if (outcome && outcome.bridgeFailure) await resetHostBridge();
    }
  }

  async function recoverDetachedWait(preferredWaitId) {
    if (
      recovering || automaticMessageInFlight || !appToken || !snapshot ||
      !automaticReentryAvailable() || snapshot.agentBusy || visibleEvent() || busy.size > 0
    ) return;
    var background = Array.isArray(snapshot.background) ? snapshot.background : [];
    var item = background.find(function (entry) {
      return (!preferredWaitId || entry.waitId === preferredWaitId) &&
        entry.status === "resolved" && !!entry.detachedAt &&
        !(entry.recoveryMessageAttemptedAt && !entry.recoveryMessageSentAt) &&
        hasRecoverableWork(entry);
    });
    if (!item) return;
    recovering = true;
    try {
      await dispatchRecovery(
        item.waitId,
        { backgroundWait: item }
      );
      await refresh(false);
    } catch (error) {
      status.textContent = "Resume available";
      console.error(error);
    } finally {
      recovering = false;
      scheduleGoalContinuation(0);
    }
  }

  function backgroundWaitForResume(goalId, taskId) {
    var background = snapshot && Array.isArray(snapshot.background) ? snapshot.background : [];
    return background.find(function (entry) {
      if (!entry || entry.status === "consumed" || entry.status === "cancelled" || !hasRecoverableWork(entry)) return false;
      if (goalId) return entry.goalId === goalId;
      if (taskId) return entry.taskId === taskId;
      return false;
    });
  }

  async function resumeThroughExistingWait(goalId, taskId) {
    var item = backgroundWaitForResume(goalId, taskId);
    if (!item) return false;
    if (
      item.status === "resolved" && item.detachedAt &&
      !(item.recoveryMessageAttemptedAt && !item.recoveryMessageSentAt) &&
      hasRecoverableWork(item)
    ) {
      await recoverDetachedWait(item.waitId);
    }
    return true;
  }

  async function applySnapshot(nextSnapshot, allowRecovery, requestSerial) {
    if (nextSnapshot && nextSnapshot.ctxId && ctxId && String(nextSnapshot.ctxId) !== ctxId) {
      throw new Error("Workspace snapshot belongs to a different Context");
    }
    var nextCursor = nextSnapshot && Number.isSafeInteger(nextSnapshot.cursor)
      ? nextSnapshot.cursor
      : undefined;
    if (nextCursor !== undefined && nextCursor < cursor) return false;
    if (
      nextCursor !== undefined && nextCursor === cursor && Number.isSafeInteger(requestSerial) &&
      requestSerial < lastAppliedSnapshotSerial
    ) return false;
    if (nextCursor === undefined && Number.isSafeInteger(requestSerial) && requestSerial < lastAppliedSnapshotSerial) return false;
    snapshot = nextSnapshot;
    if (snapshot && snapshot.ctxId) ctxId = String(snapshot.ctxId);
    if (snapshot && Number.isSafeInteger(snapshot.cursor)) cursor = snapshot.cursor;
    if (Number.isSafeInteger(requestSerial)) {
      lastAppliedSnapshotSerial = Math.max(lastAppliedSnapshotSerial, requestSerial);
    }
    reconcileTaskCancelConfirmations();
    persistWorkspaceHint();
    render();
    await syncModelContext();
    scheduleGoalContinuation(0);
    if (allowRecovery !== false) void recoverDetachedWait();
  }

  async function refresh(allowRecovery, generation, signal) {
    if (!initialized || !ctxId || (generation !== undefined && generation !== watchGeneration) || (signal && signal.aborted)) return;
    var requestSerial = ++snapshotRequestSerial;
    try {
      var nextSnapshot;
      if (directLiveAvailable()) {
        try {
          nextSnapshot = await readLiveSnapshot(signal);
        } catch (error) {
          if (signal && signal.aborted) throw error;
          if (workspaceTerminalStatus(error)) throw error;
          suppressLiveTransport();
          nextSnapshot = structured(await callTool("workspace_snapshot", {}, true, signal));
        }
      } else {
        nextSnapshot = structured(await callTool("workspace_snapshot", {}, true, signal));
      }
      if ((generation !== undefined && generation !== watchGeneration) || (signal && signal.aborted)) return;
      await applySnapshot(nextSnapshot, allowRecovery, requestSerial);
      status.textContent = "";
    } catch (error) {
      status.textContent = workspaceTerminalStatus(error) || "Reconnecting";
      throw error;
    }
  }

  async function reconnectWorkspace(generation, signal) {
    if (!initialized || !ctxId || (generation !== undefined && generation !== watchGeneration) || (signal && signal.aborted)) return;
    var requestSerial = ++snapshotRequestSerial;
    var result = await callTool("workspace_reconnect", {}, true, signal);
    if ((generation !== undefined && generation !== watchGeneration) || (signal && signal.aborted)) return;
    await applySnapshot(structured(result), true, requestSerial);
    status.textContent = "";
  }

  function workspaceAuthorizationFailed(error) {
    var message = error && error.message ? String(error.message) : String(error || "");
    return message.indexOf("Workspace App authorization is invalid") >= 0;
  }

  function workspaceContextExpired(error) {
    var message = error && error.message ? String(error.message) : String(error || "");
    return /expired|reactivate the same Context/i.test(message);
  }

  function workspaceContextDisabled(error) {
    var message = error && error.message ? String(error.message) : String(error || "");
    return /ctxId is disabled|Context is disabled/i.test(message);
  }

  function workspaceTerminalStatus(error) {
    if (workspaceContextExpired(error)) return "Context expired — continue in chat";
    if (workspaceContextDisabled(error)) return "Context disabled";
    if (workspaceAuthorizationFailed(error)) return "Reopen Workspace";
    return "";
  }

  function hostBridgeTransportFailure(error) {
    var code = error && typeof error.code === "number" ? error.code : undefined;
    return code === -32000 || code === -32001;
  }

  function invalidateHostBridgeGeneration() {
    hostBridgeGeneration += 1;
    modelContextEpoch += 1;
    if (modelContextSyncController) modelContextSyncController.abort("Host bridge changed");
  }

  async function resetHostBridge() {
    if (shuttingDown || bridgeResetting) return;
    bridgeResetting = true;
    invalidateHostBridgeGeneration();
    bridgeReady = false;
    reconnectOnStart = true;
    status.textContent = "Reconnecting";
    stopHostSizeTracking();
    stopLive();
    try {
      await app.close();
    } catch (_) {
    } finally {
      bridgeResetting = false;
      scheduleConnectRetry();
    }
  }

  function scheduleConnectRetry() {
    if (shuttingDown || bridgeReady || connectRetryTimer) return;
    connectRetryTimer = setTimeout(function () {
      connectRetryTimer = null;
      void connect();
    }, LIVE_START_RETRY_MS);
  }

  function scheduleLiveStartRetry(error) {
    var terminalStatus = workspaceTerminalStatus(error);
    if (terminalStatus) {
      status.textContent = terminalStatus;
      return;
    }
    status.textContent = "Reconnecting";
    if (shuttingDown || !initialized || !ctxId || liveStartRetryTimer) return;
    liveStartRetryTimer = setTimeout(function () {
      liveStartRetryTimer = null;
      void ensureLiveStarted();
    }, LIVE_START_RETRY_MS);
  }

  async function ensureLiveStarted() {
    if (shuttingDown || !initialized || !ctxId) return;
    if (liveStartRetryTimer) {
      clearTimeout(liveStartRetryTimer);
      liveStartRetryTimer = null;
    }
    try {
      await startLive();
    } catch (error) {
      console.error(error);
      scheduleLiveStartRetry(error);
    }
  }

  function sleep(milliseconds) {
    return new Promise(function (resolve) { setTimeout(resolve, milliseconds); });
  }

  async function watch(generation) {
    while (generation === watchGeneration) {
      var requestSerial = ++snapshotRequestSerial;
      var controller = new AbortController();
      liveAbortController = controller;
      try {
        var update;
        if (directLiveAvailable()) {
          try {
            update = await readLiveWatch(controller.signal);
          } catch (error) {
            if (controller.signal.aborted) throw error;
            if (workspaceTerminalStatus(error)) throw error;
            suppressLiveTransport();
            update = structured(await callTool("workspace_watch", { cursor: cursor }, true, controller.signal)) || {};
          }
        } else {
          update = structured(await callTool("workspace_watch", { cursor: cursor }, true, controller.signal)) || {};
        }
        if (generation !== watchGeneration) return;
        if (update.snapshot) {
          await applySnapshot(update.snapshot, true, requestSerial);
        } else if (Number.isSafeInteger(update.cursor) && update.cursor > cursor) {
          cursor = update.cursor;
        }
        status.textContent = "";
      } catch (error) {
        if (generation !== watchGeneration || controller.signal.aborted) return;
        status.textContent = "Reconnecting";
        console.error(error);
        if (generation !== watchGeneration) return;
        var terminalStatus = workspaceTerminalStatus(error);
        if (terminalStatus) {
          watchStarted = false;
          status.textContent = terminalStatus;
          return;
        } else {
          await sleep(1000);
          if (generation !== watchGeneration) return;
          try { await refresh(undefined, generation, controller.signal); } catch (_) {}
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
    var generation = ++watchGeneration;
    var controller = new AbortController();
    liveAbortController = controller;
    try {
      if (reconnectOnStart) {
        reconnectOnStart = false;
        if (directLiveAvailable()) await refresh(undefined, generation, controller.signal);
        else await reconnectWorkspace(generation, controller.signal);
      } else {
        await refresh(undefined, generation, controller.signal);
      }
      if (generation !== watchGeneration || controller.signal.aborted || !initialized || !watchStarted) return;
      if (liveAbortController === controller) liveAbortController = null;
      void watch(generation);
    } catch (error) {
      if (generation === watchGeneration) watchStarted = false;
      throw error;
    } finally {
      if (liveAbortController === controller) liveAbortController = null;
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
    presentationGeneration += 1;
    if (liveAbortController) liveAbortController.abort();
    liveAbortController = null;
    if (goalTimer) clearTimeout(goalTimer);
    goalTimer = null;
    if (connectRetryTimer) clearTimeout(connectRetryTimer);
    connectRetryTimer = null;
    if (liveStartRetryTimer) clearTimeout(liveStartRetryTimer);
    liveStartRetryTimer = null;
    if (displayModeRetryTimer) clearTimeout(displayModeRetryTimer);
    displayModeRetryTimer = null;
    displayModeRetryCount = 0;
    displayModeRequestGeneration = 0;
    presentationClaimPending = false;
    watchStarted = false;
    initialized = false;
  }

  function stopHostSizeTracking() {
    if (!sizeChangedCleanup) return;
    try { sizeChangedCleanup(); } catch (_) {}
    sizeChangedCleanup = null;
  }

  function startHostSizeTracking() {
    stopHostSizeTracking();
    try { sizeChangedCleanup = app.setupSizeChangedNotifications(); } catch (_) {}
  }

  app.ontoolinput = function (params) {
    var input = params && params.arguments;
    if (input && input.ctxId) activateCtxId(input.ctxId);
  };
  app.ontoolresult = acceptInitialOrLiveToolResult;
  app.ontoolcancelled = function (params) {
    status.textContent = "";
    if (initialized && userCancelledTool(params)) {
      void yieldAutomaticReentry(params && params.reason ? String(params.reason) : "user action").finally(function () {
        void ensureLiveStarted();
      });
    } else if (initialized) {
      void ensureLiveStarted();
    }
  };
  app.onhostcontextchanged = function (context) {
    applyHostContext(context);
    if (initialized && presentationClaimPending) void requestPreferredDisplayMode(true, presentationGeneration);
  };
  app.onclose = function () {
    if (shuttingDown || bridgeResetting) return;
    invalidateHostBridgeGeneration();
    stopHostSizeTracking();
    bridgeReady = false;
    reconnectOnStart = true;
    status.textContent = "Reconnecting";
    stopLive();
    scheduleConnectRetry();
  };
  app.onteardown = async function () {
    shuttingDown = true;
    stopHostSizeTracking();
    stopLive();
    return {};
  };

  async function requestPreferredDisplayMode(force, generation) {
    var requestGeneration = Number.isSafeInteger(generation) ? generation : presentationGeneration;
    if (shuttingDown || requestGeneration !== presentationGeneration || displayModeRequestGeneration === requestGeneration) return;
    try {
      var hostContext = asRecord(app.getHostContext()) || {};
      var hasModes = Array.isArray(hostContext.availableDisplayModes);
      var modes = hasModes
        ? hostContext.availableDisplayModes
        : [];
      if (!hasModes) return;
      if (modes.indexOf("pip") < 0) {
        presentationClaimPending = false;
        return;
      }
      if (hostContext.displayMode === "pip" && force !== true) {
        presentationClaimPending = false;
        displayModeRetryCount = 0;
        if (displayModeRetryTimer) clearTimeout(displayModeRetryTimer);
        displayModeRetryTimer = null;
        return;
      }
      if (modes.indexOf("pip") >= 0 && (force === true || hostContext.displayMode !== "pip")) {
        displayModeRequestGeneration = requestGeneration;
        var result = await app.requestDisplayMode(
          { mode: "pip" },
          { timeout: DISPLAY_MODE_TIMEOUT_MS }
        );
        if (result && result.mode === "pip") {
          if (requestGeneration !== presentationGeneration) return;
          presentationClaimPending = false;
          displayModeRetryCount = 0;
          if (displayModeRetryTimer) clearTimeout(displayModeRetryTimer);
          displayModeRetryTimer = null;
        } else {
          scheduleDisplayModeRetry(requestGeneration);
        }
      }
    } catch (_) {
      scheduleDisplayModeRetry(requestGeneration);
    } finally {
      if (displayModeRequestGeneration === requestGeneration) displayModeRequestGeneration = 0;
    }
  }

  function scheduleDisplayModeRetry(generation) {
    if (generation !== presentationGeneration || shuttingDown || !bridgeReady || !initialized || !presentationClaimPending || displayModeRetryTimer) return;
    if (displayModeRetryCount >= DISPLAY_MODE_MAX_RETRIES) {
      presentationClaimPending = false;
      return;
    }
    displayModeRetryCount += 1;
    displayModeRetryTimer = setTimeout(function () {
      displayModeRetryTimer = null;
      void requestPreferredDisplayMode(true, generation);
    }, DISPLAY_MODE_RETRY_MS * displayModeRetryCount);
  }

  async function connect() {
    if (shuttingDown || bridgeReady || bridgeConnecting) return;
    bridgeConnecting = true;
    try {
      await app.connect(undefined, { timeout: HOST_CONNECT_TIMEOUT_MS });
      startHostSizeTracking();
      applyHostContext(app.getHostContext());
      bridgeReady = true;
      initialized = true;
      presentationGeneration += 1;
      var presentationEpoch = presentationGeneration;
      displayModeRetryCount = 0;
      presentationClaimPending = true;
      if (connectRetryTimer) clearTimeout(connectRetryTimer);
      connectRetryTimer = null;
      void requestPreferredDisplayMode(true, presentationEpoch);
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
      await ensureLiveStarted();
    } catch (error) {
      status.textContent = "Host bridge unavailable";
      console.error(error);
      scheduleConnectRetry();
    } finally {
      bridgeConnecting = false;
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

  async function sendExplicitResume(text, extra, canSend) {
    var outcome = await sendModelMessage(text, extra, canSend);
    try {
      await settleAutomaticMessageClaim(outcome);
    } finally {
      if (outcome && outcome.bridgeFailure) await resetHostBridge();
    }
    if (outcome && outcome.status === "rejected") status.textContent = "Host rejected model resume";
    if (outcome && outcome.status === "uncertain") status.textContent = "Resume delivery uncertain";
    return outcome;
  }

  async function resumeGoalFromUi(goalId, revision) {
    var result = await act("goal-resume", "workspace_goal_resume", {
      goalId: goalId,
      revision: revision
    });
    if (!result || !result.goal || result.goal.status !== "active") return;
    if (await resumeThroughExistingWait(goalId, "")) return;
    await sendExplicitResume(
      "The user resumed the active Workspace Goal. Continue the Goal immediately from its current durable state; do not restart completed work.",
      { resumedGoal: result.goal },
      function () {
        var goal = snapshot && snapshot.goal;
        return !!goal && goal.goalId === goalId && goal.status === "active" &&
          !backgroundWaitForResume(goalId, "") && !snapshot.agentBusy && !visibleEvent();
      }
    );
  }

  async function resumeTaskFromUi(taskId, revision) {
    var result = await act("task:" + taskId, "workspace_task_control", {
      action: "resume",
      revision: revision,
      taskId: taskId
    });
    if (!result) return;
    if (await resumeThroughExistingWait("", taskId)) return;
    await sendExplicitResume(
      "The user resumed this Workspace task. Continue the task immediately from its current durable state.",
      { resumedTask: result },
      function () {
        var task = findTask(taskId);
        return !!task && task.status === "in_progress" &&
          !backgroundWaitForResume("", taskId) && !snapshot.agentBusy && !visibleEvent();
      }
    );
  }

  async function retryGoalAutoResume(goalId) {
    var reset = structured(await callTool("workspace_goal_continue", { action: "reset" }, true));
    if (reset && reset.goal) snapshot.goal = reset.goal;
    var resumed = structured(await callTool("workspace_reentry_control", { action: "resume" }, true));
    if (snapshot && resumed) snapshot.reentry = resumed;
    render();
    var goal = snapshot && snapshot.goal;
    if (!goal || goal.goalId !== goalId || goal.status !== "active") return;
    if (await resumeThroughExistingWait(goalId, "")) return;
    await sendExplicitResume(
      "The user explicitly retried automatic execution for this Workspace Goal. Continue immediately from the current durable Goal state.",
      { retriedGoal: goal },
      function () {
        var current = snapshot && snapshot.goal;
        return !!current && current.goalId === goalId && current.status === "active" &&
          !backgroundWaitForResume(goalId, "") && !snapshot.agentBusy && !visibleEvent();
      }
    );
  }

  async function answerQuestion(waitId, answer) {
    var result = await act(waitId, "workspace_question_answer", { waitId: waitId, answer: answer });
    if (result && result.detached && hasRecoverableWork(result)) {
      try {
        await dispatchRecovery(
          result.waitId,
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
    var exhausted = goal.autoContinueExhausted ? '<div class="goal-note"><div class="muted">Automatic resume paused</div><div>The automatic no-progress retry limit was reached. The Goal remains active.</div></div>' : '';
    var actions = "";
    if (goal.status === "blocked") {
      actions += '<button type="button" class="action-row" aria-label="Resume Goal" data-goal-resume="' + escapeHtml(goal.goalId) + '" data-goal-revision="' + escapeHtml(goal.revision) + '"' + (busy.has("goal-resume") ? ' disabled' : '') + '><span>Resume Goal</span><span class="muted">continue agent work</span></button>';
    }
    if (goal.status === "active" && (goal.autoContinueExhausted || goal.continuationUncertain)) {
      actions += '<button type="button" class="action-row" aria-label="Retry Goal" data-goal-retry="' + escapeHtml(goal.goalId) + '"' + (busy.has("goal-retry") ? ' disabled' : '') + '><span>Retry Goal</span><span class="muted">explicitly resume model execution</span></button>';
    }
    actions += '<button type="button" class="action-row danger-row" aria-label="Stop Goal" data-goal-stop="' + escapeHtml(goal.goalId) + '" data-goal-revision="' + escapeHtml(goal.revision) + '"' + (busy.has("goal-stop") ? ' disabled' : '') + '><span>Stop Goal</span><span class="muted">keep processes running</span></button>';
    var statusLabel = goal.continuationUncertain ? "Delivery uncertain" : goal.autoContinueExhausted ? "Resume paused" : goal.status === "blocked" ? "Blocked" : "Active";
    return '<div class="card">' + eventHead("Goal", statusLabel) + '<div class="card-body"><div class="question">' + escapeHtml(goal.objective) + '</div>' + progress + currentStep + note + uncertain + exhausted + '</div>' + actions + '</div>';
  }

  function render() {
    if (!snapshot) return;
    var item = visibleEvent();
    var eventCard = !item ? ""
      : item.kind === "question" ? questionCard(item)
      : item.kind === "approval" ? approvalCard(item)
      : "";
    var content = eventCard + goalCard() + (item ? "" : taskCards()) + backgroundWaitCards();
    root.innerHTML = content || '<div class="card"><div class="card-head"><div class="row"><span class="event-name">Workspace</span><span class="badge">Ready</span></div></div><div class="card-body"><div class="muted">No active goal, task, question, approval, or background wait.</div></div></div>';
  }

  root.addEventListener("click", function (event) {
    var goalResume = event.target.closest("[data-goal-resume]");
    if (goalResume && !goalResume.hasAttribute("disabled")) {
      void resumeGoalFromUi(
        goalResume.getAttribute("data-goal-resume"),
        Number(goalResume.getAttribute("data-goal-revision"))
      );
      return;
    }
    var goalRetry = event.target.closest("[data-goal-retry]");
    if (goalRetry && !goalRetry.hasAttribute("disabled")) {
      void retryGoalAutoResume(goalRetry.getAttribute("data-goal-retry"));
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
        if (taskAction === "resume") {
          void resumeTaskFromUi(taskId, Number(taskControl.getAttribute("data-task-revision")));
        } else {
          void act("task:" + taskId, "workspace_task_control", {
            action: taskAction,
            revision: Number(taskControl.getAttribute("data-task-revision")),
            taskId: taskId
          });
        }
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
    if (configureFromOpenAiGlobals(detail && detail.globals) && initialized) void ensureLiveStarted();
  });
  window.addEventListener("beforeunload", function () {
    shuttingDown = true;
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
