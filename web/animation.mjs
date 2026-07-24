const TRANSITIONS = Object.freeze({
  idle: Object.freeze({ play: "running", restart: "idle", select: "idle" }),
  running: Object.freeze({ pause: "paused", restart: "idle", select: "idle", complete: "complete" }),
  paused: Object.freeze({ play: "running", restart: "idle", select: "idle" }),
  complete: Object.freeze({ restart: "idle", select: "idle" }),
});

const DEFAULT_TIMING = Object.freeze({ source: 420, travel: 720, reveal: 420 });
const REDUCED_TIMING = Object.freeze({ source: 20, travel: 20, reveal: 20 });
const STATE_LABEL = Object.freeze({
  healthy: "Healthy",
  degraded: "Degraded",
  unhealthy: "Unhealthy",
  unknown: "Unknown",
  alt: "Standby",
});

let replaySequence = 0;

export function nextReplayState(state, event) {
  if (!Object.hasOwn(TRANSITIONS, state)) {
    throw new Error(`unknown replay state "${state}"`);
  }
  return TRANSITIONS[state][event] || state;
}

export function buildReplayScenarios(model) {
  const entities = Array.isArray(model?.entities) ? model.entities : [];
  const signals = Array.isArray(model?.signals) ? model.signals : [];
  const relationships = Array.isArray(model?.relationships) ? model.relationships : [];
  const entityById = new Map(entities.map((entity) => [entity.id, entity]));
  const outgoing = new Map(entities.map((entity) => [entity.id, []]));

  for (const relationship of relationships) {
    if (!entityById.has(relationship.from) || !entityById.has(relationship.to)) {
      throw new Error(
        `relationship "${relationship.id}" references an unknown endpoint "${relationship.from}" → "${relationship.to}"`,
      );
    }
    outgoing.get(relationship.from).push(relationship);
  }

  return signals.map((signal) => {
    const owner = entityById.get(signal.ownerId);
    if (!owner) {
      throw new Error(`signal "${signal.id}" references unknown owner "${signal.ownerId}"`);
    }

    const visitedEntities = new Set([owner.id]);
    const visitedEdges = new Set();
    const queue = [{ id: owner.id, hop: 0 }];
    const entityIds = [owner.id];
    const edgeIds = [];
    const steps = [];

    while (queue.length) {
      const current = queue.shift();
      for (const relationship of outgoing.get(current.id) || []) {
        if (visitedEdges.has(relationship.id)) continue;
        visitedEdges.add(relationship.id);
        edgeIds.push(relationship.id);

        const target = entityById.get(relationship.to);
        const isNewTarget = !visitedEntities.has(target.id);
        if (isNewTarget) {
          visitedEntities.add(target.id);
          entityIds.push(target.id);
          queue.push({ id: target.id, hop: current.hop + 1 });
        }

        const logic = [
          ...(relationship.label ? [relationship.label] : []),
          ...(target.qualifier ? [target.qualifier] : []),
        ];
        const logicNarration = logic.length
          ? [
            ...(relationship.label ? [`Relationship annotation: ${relationship.label}.`] : []),
            ...(target.qualifier ? [`Entity annotation: ${target.qualifier}.`] : []),
          ].join(" ")
          : "Rollup rule not specified.";

        steps.push({
          edgeId: relationship.id,
          fromId: relationship.from,
          toId: relationship.to,
          targetId: isNewTarget ? target.id : null,
          hop: current.hop + 1,
          logic,
          logicNarration,
          narration: `Propagation ${entityById.get(relationship.from).name} → ${target.name}. ${logicNarration}`,
        });
      }
    }

    return {
      id: signal.id,
      label: `${signal.name} — ${owner.name}`,
      source: signal,
      owner,
      entityIds,
      edgeIds,
      steps,
      sourceNarration:
        `Authored static signal ${signal.name} reveals ${signal.result} (${STATE_LABEL[signal.state] || signal.state}). ` +
        "This replay explains authored state; it is not live evaluation.",
    };
  });
}

function elementsByData(root, name, value) {
  return [...root.querySelectorAll(`[data-ahm-${name}]`)]
    .filter((node) => node.getAttribute(`data-ahm-${name}`) === value);
}

function firstByData(root, name, value) {
  return elementsByData(root, name, value)[0] || null;
}

function makeElement(doc, tag, { className, text, attrs = {} } = {}) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  return node;
}

export function mountSignalReplay(svgWrap, model, options = {}) {
  const doc = svgWrap.ownerDocument;
  const win = doc.defaultView;
  const svg = svgWrap.querySelector("svg");
  const scenarios = buildReplayScenarios(model);
  const section = makeElement(doc, "section", {
    className: "ahm-replay",
    attrs: { "aria-label": "Signal replay", "data-ahm-replay": "" },
  });
  const explainer = makeElement(doc, "p", {
    className: "ahm-replay-explainer",
    text: "Explanatory replay of authored static state. It does not calculate or monitor live health.",
  });

  if (!svg || scenarios.length === 0) {
    section.append(
      makeElement(doc, "p", {
        className: "ahm-replay-empty",
        text: "No signals to animate",
        attrs: { role: "status" },
      }),
      explainer,
    );
    svgWrap.prepend(section);
    return { cleanup() {} };
  }

  const id = `ahm-replay-${++replaySequence}`;
  const toolbar = makeElement(doc, "div", { className: "ahm-replay-toolbar" });
  const label = makeElement(doc, "label", { text: "Signal replay", attrs: { for: `${id}-scenario` } });
  const select = makeElement(doc, "select", {
    attrs: { id: `${id}-scenario`, "data-ahm-control": "scenario" },
  });
  for (const scenario of scenarios) {
    select.append(makeElement(doc, "option", { text: scenario.label, attrs: { value: scenario.id } }));
  }
  const playButton = makeElement(doc, "button", {
    text: "Play",
    attrs: { type: "button", "data-ahm-control": "play" },
  });
  const pauseButton = makeElement(doc, "button", {
    text: "Pause",
    attrs: { type: "button", "data-ahm-control": "pause" },
  });
  const restartButton = makeElement(doc, "button", {
    text: "Restart",
    attrs: { type: "button", "data-ahm-control": "restart" },
  });
  const narration = makeElement(doc, "p", {
    className: "ahm-replay-narration",
    text: "Ready. The selected signal starts at a neutral pending value.",
    attrs: {
      role: "status",
      "aria-live": "polite",
      "aria-atomic": "true",
      "data-ahm-narration": "",
    },
  });
  toolbar.append(label, select, playButton, pauseButton, restartButton);
  section.append(toolbar, explainer, narration);
  svgWrap.prepend(section);

  const stateByEntity = new Map(model.entities.map((entity) => [entity.id, entity.state]));
  let state = "idle";
  let scenario = scenarios[0];
  let edgeIndex = 0;
  let phase = "idle";
  let timerId = null;
  let timerDue = 0;
  let timerRemaining = 0;
  let timerCallback = null;
  let travelAnimations = [];
  let travelOverlays = [];
  let destroyed = false;

  const now = () => win?.performance?.now?.() ?? Date.now();
  const isReducedMotion = () => options.reducedMotion ??
    Boolean(win?.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  const timing = () => isReducedMotion() ? REDUCED_TIMING : { ...DEFAULT_TIMING, ...(options.timing || {}) };

  function emit(type, detail = {}) {
    if (!win?.CustomEvent) return;
    section.dispatchEvent(new win.CustomEvent("ahm-replay-step", {
      bubbles: true,
      detail: {
        type,
        state,
        phase,
        stepIndex: Number(section.dataset.stepIndex),
        scenarioId: scenario.id,
        ...detail,
      },
    }));
  }

  function renderState() {
    section.dataset.state = state;
    section.dataset.phase = phase;
    section.dataset.scenario = scenario.id;
    playButton.textContent = state === "paused" ? "Resume" : "Play";
    playButton.disabled = state === "running" || state === "complete";
    pauseButton.disabled = state !== "running";
    restartButton.disabled = state === "idle" && phase === "idle";
  }

  function clearTimer() {
    if (timerId != null) win.clearTimeout(timerId);
    timerId = null;
    timerDue = 0;
  }

  function schedule(callback, delay) {
    clearTimer();
    timerCallback = callback;
    timerRemaining = delay;
    timerDue = now() + delay;
    timerId = win.setTimeout(() => {
      timerId = null;
      timerDue = 0;
      timerRemaining = 0;
      const next = timerCallback;
      timerCallback = null;
      if (!destroyed && state === "running") next?.();
    }, delay);
  }

  function clearTravel() {
    for (const animation of travelAnimations) animation.cancel();
    for (const overlay of travelOverlays) overlay.remove();
    travelAnimations = [];
    travelOverlays = [];
  }

  function restoreEntityState(entityId) {
    const entity = firstByData(svg, "entity", entityId);
    if (!entity) return;
    entity.classList.remove("ahm-awaiting");
    entity.classList.add("ahm-revealed");
    entity.dataset.ahmPhase = "revealed";
    const labelNode = entity.querySelector('[data-ahm-part="entity-state"] text');
    if (labelNode) labelNode.textContent = STATE_LABEL[stateByEntity.get(entityId)] || stateByEntity.get(entityId);
  }

  function clearScenarioMarks() {
    clearTravel();
    for (const node of svg.querySelectorAll(
      "[data-ahm-entity], [data-ahm-signal], [data-ahm-edge], [data-ahm-edge-label], [data-ahm-logic]",
    )) {
      node.classList.remove(
        "ahm-causal",
        "ahm-unrelated",
        "ahm-source",
        "ahm-pending",
        "ahm-revealed",
        "ahm-awaiting",
        "ahm-edge-active",
        "ahm-logic-active",
      );
      delete node.dataset.ahmPhase;
    }
    for (const result of svg.querySelectorAll('[data-ahm-part="signal-result"]')) {
      result.textContent = result.dataset.ahmFinalResult ?? "";
    }
    for (const entity of model.entities) {
      const entityNode = firstByData(svg, "entity", entity.id);
      const labelNode = entityNode?.querySelector('[data-ahm-part="entity-state"] text');
      if (labelNode) labelNode.textContent = STATE_LABEL[entity.state] || entity.state;
    }
  }

  function applyScenario() {
    clearScenarioMarks();
    const causalEntities = new Set(scenario.entityIds);
    const causalEdges = new Set(scenario.edgeIds);
    for (const node of svg.querySelectorAll("[data-ahm-entity]")) {
      const causal = causalEntities.has(node.dataset.ahmEntity);
      node.classList.add(causal ? "ahm-causal" : "ahm-unrelated");
      if (causal && node.dataset.ahmEntity !== scenario.owner.id) {
        node.classList.add("ahm-awaiting");
        const stateLabel = node.querySelector('[data-ahm-part="entity-state"] text');
        if (stateLabel) stateLabel.textContent = "Pending";
      }
    }
    for (const node of svg.querySelectorAll("[data-ahm-signal]")) {
      const isSource = node.dataset.ahmSignal === scenario.id;
      node.classList.add(isSource ? "ahm-causal" : "ahm-unrelated");
      if (isSource) {
        node.classList.add("ahm-source", "ahm-pending");
        node.dataset.ahmPhase = "pending";
        const result = node.querySelector('[data-ahm-part="signal-result"]');
        if (result) result.textContent = "—";
      }
    }
    for (const node of svg.querySelectorAll("[data-ahm-edge]")) {
      node.classList.add(causalEdges.has(node.dataset.ahmEdge) ? "ahm-causal" : "ahm-unrelated");
    }
    for (const node of svg.querySelectorAll("[data-ahm-edge-label]")) {
      node.classList.add(causalEdges.has(node.dataset.ahmEdgeLabel) ? "ahm-causal" : "ahm-unrelated");
    }
  }

  function activateLogic(step) {
    for (const node of svg.querySelectorAll(".ahm-logic-active")) node.classList.remove("ahm-logic-active");
    for (const node of elementsByData(svg, "edge-label", step.edgeId)) node.classList.add("ahm-logic-active");
    for (const node of elementsByData(svg, "qualifier", step.toId)) node.classList.add("ahm-logic-active");
  }

  function beginTravel(step) {
    phase = isReducedMotion() ? "causal" : "travelling";
    section.dataset.stepIndex = String(edgeIndex + 1);
    activateLogic(step);
    const paths = elementsByData(svg, "edge", step.edgeId);
    for (const path of paths) {
      path.classList.add("ahm-edge-active");
      path.dataset.ahmPhase = phase;
      if (isReducedMotion()) continue;
      const overlay = path.cloneNode(false);
      overlay.removeAttribute("data-ahm-edge");
      overlay.removeAttribute("data-ahm-part");
      overlay.removeAttribute("data-ahm-phase");
      overlay.setAttribute("data-ahm-travel-overlay", step.edgeId);
      overlay.setAttribute("aria-hidden", "true");
      overlay.classList.add("ahm-travel-path");
      path.after(overlay);
      travelOverlays.push(overlay);
      if (typeof overlay.animate === "function") {
        travelAnimations.push(overlay.animate(
          [{ strokeDashoffset: "21" }, { strokeDashoffset: "0" }],
          { duration: timing().travel, iterations: Infinity, easing: "linear" },
        ));
      }
    }
    narration.textContent = step.narration;
    renderState();
    schedule(() => revealStep(step), timing().travel);
    emit("travel", { edgeId: step.edgeId, targetId: step.targetId, logic: step.logic });
  }

  function revealStep(step) {
    clearTravel();
    for (const path of elementsByData(svg, "edge", step.edgeId)) {
      path.dataset.ahmPhase = "complete";
    }
    phase = "revealed";
    if (step.targetId) {
      restoreEntityState(step.targetId);
      const entity = model.entities.find(({ id }) => id === step.targetId);
      narration.textContent =
        `${entity.name} is revealed in its authored ${STATE_LABEL[entity.state] || entity.state} state. ${step.logicNarration}`;
    } else {
      narration.textContent = `${step.narration} The target was already revealed; this relationship is shown once.`;
    }
    renderState();
    edgeIndex += 1;
    schedule(runNextEdge, timing().reveal);
    emit("reveal", { edgeId: step.edgeId, targetId: step.targetId, logic: step.logic });
  }

  function runNextEdge() {
    if (edgeIndex >= scenario.steps.length) {
      phase = "complete";
      section.dataset.stepIndex = String(scenario.steps.length + 1);
      state = nextReplayState(state, "complete");
      narration.textContent = "Replay complete. All authored reachable states and annotations have been shown.";
      renderState();
      emit("complete");
      return;
    }
    beginTravel(scenario.steps[edgeIndex]);
  }

  function revealSource() {
    phase = "source";
    section.dataset.stepIndex = "0";
    const source = firstByData(svg, "signal", scenario.id);
    source?.classList.remove("ahm-pending");
    source?.classList.add("ahm-revealed");
    if (source) source.dataset.ahmPhase = "revealed";
    const result = source?.querySelector('[data-ahm-part="signal-result"]');
    if (result) result.textContent = scenario.source.result;
    narration.textContent = scenario.sourceNarration;
    renderState();
    schedule(runNextEdge, timing().source);
    emit("source", {
      signalId: scenario.id,
      result: scenario.source.result,
      signalState: scenario.source.state,
    });
  }

  function reset(nextScenario = scenario) {
    clearTimer();
    timerCallback = null;
    timerRemaining = 0;
    scenario = nextScenario;
    edgeIndex = 0;
    phase = "idle";
    section.dataset.stepIndex = "-1";
    narration.textContent = "Ready. The selected signal starts at a neutral pending value.";
    applyScenario();
    renderState();
  }

  function dispatch(event) {
    if (destroyed) return;
    const previous = state;
    const target = nextReplayState(previous, event);
    if (event === "select") {
      state = target;
      reset(scenarios.find(({ id: scenarioId }) => scenarioId === select.value) || scenarios[0]);
      emit("select");
      return;
    }
    if (event === "restart") {
      state = target;
      reset();
      emit("restart");
      return;
    }
    if (event === "pause" && target === "paused") {
      timerRemaining = timerId == null ? 0 : Math.max(0, timerDue - now());
      clearTimer();
      for (const animation of travelAnimations) animation.pause();
      state = target;
      renderState();
      emit("pause");
      return;
    }
    if (event === "play" && target === "running") {
      state = target;
      renderState();
      if (previous === "paused") {
        for (const animation of travelAnimations) animation.play();
        if (timerCallback) schedule(timerCallback, timerRemaining);
        emit("resume");
      } else {
        revealSource();
      }
    }
  }

  playButton.addEventListener("click", () => dispatch("play"));
  pauseButton.addEventListener("click", () => dispatch("pause"));
  restartButton.addEventListener("click", () => dispatch("restart"));
  select.addEventListener("change", () => dispatch("select"));

  reset();

  return {
    dispatch,
    cleanup() {
      if (destroyed) return;
      destroyed = true;
      clearTimer();
      timerCallback = null;
      clearScenarioMarks();
    },
  };
}
