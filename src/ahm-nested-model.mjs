import { normalizeEntityState } from "./ahm-tokens.mjs";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function expectKnownKeys(path, value, keys) {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`unsupported ${path} key "${key}"`);
  }
}

function asNonEmptyString(value, path) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value.trim();
}

function isAncestor(modelParent, maybeAncestorId, modelId) {
  let parent = modelParent.get(modelId) ?? null;
  while (parent) {
    if (parent === maybeAncestorId) return true;
    parent = modelParent.get(parent) ?? null;
  }
  return false;
}

function collectModelAncestors(modelParent, modelId) {
  const ancestors = [];
  let parent = modelParent.get(modelId) ?? null;
  while (parent) {
    ancestors.push(parent);
    parent = modelParent.get(parent) ?? null;
  }
  return ancestors;
}

function uniqueStable(values) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

export function projectNestedModel({ canonical, parsed, nested }) {
  if (!isObject(canonical)) throw new Error("canonical must be an object");
  if (!isObject(parsed)) throw new Error("parsed must be a parsed source object");
  if (!Array.isArray(canonical.entities)) throw new Error("canonical.entities must be an array");
  if (!Array.isArray(canonical.dependencies)) throw new Error("canonical.dependencies must be an array");

  const entities = canonical.entities.map((entity) => ({
    ...entity,
    signals: [...(entity.signals ?? [])],
  }));
  const entityIds = new Set(entities.map((entity) => entity.id));
  const signalIds = new Set();
  for (const entity of entities) {
    for (const signal of entity.signals ?? []) {
      if (signal?.signalId) signalIds.add(signal.signalId);
    }
  }

  // source subgraph hierarchy: the parent of each nested subgraph, the top-level groups, and the
  // entities each subgraph holds directly or through nested subgraphs
  const subgraphs = parsed?.subgraphs ?? [];
  const subgraphById = new Map(subgraphs.map((subgraph) => [subgraph.id, subgraph]));
  const parentById = new Map();
  const nestedIds = new Set();
  for (const subgraph of subgraphs) {
    for (const member of subgraph.nodes ?? []) {
      if (!subgraphById.has(member)) continue;
      nestedIds.add(member);
      parentById.set(member, subgraph.id);
    }
  }
  const topLevel = subgraphs.filter((subgraph) => !nestedIds.has(subgraph.id));
  const entitiesBySubgraph = new Map();
  const collectEntities = (id, seen = new Set()) => {
    if (seen.has(id)) return [];
    seen.add(id);
    const subgraph = subgraphById.get(id);
    if (!subgraph) return [];
    const members = [];
    for (const member of subgraph.nodes ?? []) {
      if (entityIds.has(member)) {
        members.push(member);
        continue;
      }
      if (subgraphById.has(member)) members.push(...collectEntities(member, seen));
    }
    return members;
  };
  for (const subgraph of subgraphs) {
    entitiesBySubgraph.set(subgraph.id, [...new Set(collectEntities(subgraph.id))]);
  }

  // nested contract: option shape, view mode and the registered models
  if (!isObject(nested)) throw new Error("nested must be an object");
  expectKnownKeys("nested", nested, ["models", "view"]);
  if (!isObject(nested.models)) throw new Error("nested.models must be an object");
  if (!isObject(nested.view)) throw new Error("nested.view must be an object");
  expectKnownKeys("nested.view", nested.view, ["mode", "detailFocus"]);
  const mode = nested.view.mode;
  if (!["expanded", "collapsed", "detail"].includes(mode)) {
    throw new Error(`unsupported nested.view.mode "${mode}"`);
  }
  if (mode === "detail") {
    asNonEmptyString(nested.view.detailFocus, "nested.view.detailFocus");
  } else if (nested.view.detailFocus !== undefined) {
    throw new Error("detailFocus is only allowed in detail mode");
  }
  const models = new Map();
  for (const [modelId, value] of Object.entries(nested.models)) {
    if (modelId.trim() === "") throw new Error("nested.models key must be a non-empty string");
    if (entityIds.has(modelId)) throw new Error(`nested model id "${modelId}" collides with an entity ID`);
    if (signalIds.has(modelId)) throw new Error(`nested model id "${modelId}" collides with a signal ID`);
    if (!subgraphById.has(modelId)) throw new Error(`nested model id "${modelId}" is not a source subgraph ID`);
    if (!isObject(value)) throw new Error(`nested.models.${modelId} must be an object`);
    expectKnownKeys(`nested.models.${modelId}`, value, ["state", "detailRef"]);
    if (!Object.hasOwn(value, "state")) {
      throw new Error(`nested.models.${modelId}.state must be provided`);
    }
    let state;
    try {
      state = normalizeEntityState(value.state);
    } catch (error) {
      throw new Error(`nested.models.${modelId}.state ${error.message}`);
    }
    const detailRef = value.detailRef;
    if (detailRef !== undefined && (typeof detailRef !== "string" || detailRef.trim() === "")) {
      throw new Error(`nested.models.${modelId}.detailRef must be a non-empty string when provided`);
    }
    models.set(modelId, { state, detailRef: detailRef?.trim() ?? null });
  }
  if (mode === "detail" && !models.has(nested.view.detailFocus)) {
    throw new Error(`detailFocus "${nested.view.detailFocus}" must reference a registered model`);
  }
  const detailFocus = nested.view.detailFocus ?? null;

  // model tree: each model's nearest registered ancestor model, and the entities it owns in
  // total and directly (not through a nested model)
  const modelParent = new Map();
  const modelChildren = new Map();
  const allEntityIdsByModel = new Map();
  const directEntityIdsByModel = new Map();
  for (const modelId of models.keys()) {
    let parentId = null;
    for (let parent = parentById.get(modelId) ?? null; parent; parent = parentById.get(parent) ?? null) {
      if (models.has(parent)) {
        parentId = parent;
        break;
      }
    }
    modelParent.set(modelId, parentId);
    if (parentId) {
      if (!modelChildren.has(parentId)) modelChildren.set(parentId, []);
      modelChildren.get(parentId).push(modelId);
    }
    allEntityIdsByModel.set(modelId, entitiesBySubgraph.get(modelId) ?? []);
  }
  for (const modelId of models.keys()) {
    const descendants = [];
    const queue = [...(modelChildren.get(modelId) ?? [])];
    while (queue.length > 0) {
      const current = queue.shift();
      descendants.push(current);
      queue.push(...(modelChildren.get(current) ?? []));
    }
    const nestedEntities = new Set(descendants.flatMap((childId) => allEntityIdsByModel.get(childId) ?? []));
    const direct = (allEntityIdsByModel.get(modelId) ?? []).filter((entityId) => !nestedEntities.has(entityId));
    directEntityIdsByModel.set(modelId, direct);
  }

  const modelsByEntity = new Map();
  for (const [modelId, allEntityIds] of allEntityIdsByModel.entries()) {
    for (const entityId of allEntityIds) {
      if (!modelsByEntity.has(entityId)) modelsByEntity.set(entityId, []);
      modelsByEntity.get(entityId).push(modelId);
    }
  }

  for (const [entityId, modelIds] of modelsByEntity.entries()) {
    for (let i = 0; i < modelIds.length; i += 1) {
      for (let j = i + 1; j < modelIds.length; j += 1) {
        const a = modelIds[i];
        const b = modelIds[j];
        const nestedPair = isAncestor(modelParent, a, b) || isAncestor(modelParent, b, a);
        if (!nestedPair) {
          throw new Error(`conflicting entity membership for "${entityId}" across disjoint models "${a}" and "${b}"`);
        }
      }
    }
  }

  const nearestModelByEntity = new Map();
  for (const entity of entities) {
    const containing = modelsByEntity.get(entity.id) ?? [];
    if (containing.length === 0) continue;
    const nearest = containing
      .slice()
      .sort((left, right) => collectModelAncestors(modelParent, right).length - collectModelAncestors(modelParent, left).length)[0];
    nearestModelByEntity.set(entity.id, nearest);
  }

  const modelStateById = new Map();
  for (const [id, modelConfig] of models.entries()) {
    modelStateById.set(id, modelConfig.state);
  }
  const entityStateById = new Map(entities.map((entity) => [entity.id, entity.state]));

  const endpointKind = (endpointId) => {
    if (entityIds.has(endpointId)) return "entity";
    if (models.has(endpointId)) return "model";
    if (subgraphById.has(endpointId)) return "group";
    if (signalIds.has(endpointId)) return "signal";
    return "unknown";
  };

  const topAncestorModel = (modelId) => {
    let current = modelId;
    let parent = modelParent.get(current) ?? null;
    while (parent) {
      current = parent;
      parent = modelParent.get(current) ?? null;
    }
    return current;
  };

  const allModelIds = [...models.keys()];
  const topLevelModels = uniqueStable(
    allModelIds.filter((modelId) => modelParent.get(modelId) == null)
  );
  const detailModelIds = mode === "detail"
    ? allModelIds.filter((modelId) => {
      if (modelId === detailFocus) return true;
      return isAncestor(modelParent, detailFocus, modelId);
    })
    : [];
  const detailModelSet = new Set(detailModelIds);
  const detailEntitySet = new Set(
    mode === "detail"
      ? entities
        .map((entity) => entity.id)
        .filter((entityId) => {
          const owner = nearestModelByEntity.get(entityId);
          return owner != null && detailModelSet.has(owner);
        })
      : []
  );

  const mapCollapsedEndpoint = (endpointId, kind) => {
    if (kind === "entity") {
      const owner = nearestModelByEntity.get(endpointId);
      if (!owner) return endpointId;
      return topAncestorModel(owner);
    }
    if (kind === "model") return topAncestorModel(endpointId);
    return null;
  };

  const originalSourceState = (endpointId, kind) => {
    if (kind === "entity") return entityStateById.get(endpointId);
    if (kind === "model") return modelStateById.get(endpointId);
    return null;
  };

  const renderedRelationships = [];
  const traceRelationships = [];
  for (let dependencyIndex = 0; dependencyIndex < canonical.dependencies.length; dependencyIndex += 1) {
    const dep = canonical.dependencies[dependencyIndex];
    const from = asNonEmptyString(dep.from, `dependencies[${dependencyIndex}].from`);
    const to = asNonEmptyString(dep.to, `dependencies[${dependencyIndex}].to`);
    const fromKind = endpointKind(from);
    const toKind = endpointKind(to);
    if (fromKind === "group" || toKind === "group") {
      const endpoint = fromKind === "group" ? from : to;
      throw new Error(`unsupported dependency endpoint "${endpoint}" from unregistered group`);
    }
    if (fromKind === "signal" || toKind === "signal") {
      const endpoint = fromKind === "signal" ? from : to;
      throw new Error(`unsupported dependency endpoint "${endpoint}" from signal ownership edge`);
    }
    if (fromKind === "unknown" || toKind === "unknown") {
      const endpoint = fromKind === "unknown" ? from : to;
      throw new Error(`unknown dependency endpoint "${endpoint}"`);
    }

    let displayedFrom = from;
    let displayedTo = to;
    let kind = "rendered";

    if (mode === "collapsed") {
      displayedFrom = mapCollapsedEndpoint(from, fromKind);
      displayedTo = mapCollapsedEndpoint(to, toKind);
      if (displayedFrom === displayedTo) {
        const authoredModelSelf = from === to && fromKind === "model";
        if (!authoredModelSelf) {
          kind = "detail-only";
          displayedFrom = null;
          displayedTo = null;
        }
      }
    }

    if (mode === "detail") {
      const fromInScope = fromKind === "model" ? detailModelSet.has(from) : detailEntitySet.has(from);
      const toInScope = toKind === "model" ? detailModelSet.has(to) : detailEntitySet.has(to);
      if (!fromInScope || !toInScope) {
        kind = "outside-focus";
        displayedFrom = null;
        displayedTo = null;
      }
    }

    const displayedSourceState = displayedFrom == null
      ? null
      : originalSourceState(
        displayedFrom,
        models.has(displayedFrom) ? "model" : "entity"
      );

    if (kind === "rendered") {
      renderedRelationships.push({
        dependencyIndex,
        from: displayedFrom,
        to: displayedTo,
        label: dep.label ?? null,
        dashed: Boolean(dep.dashed),
        sourceState: displayedSourceState,
      });
    }

    traceRelationships.push({
      dependencyIndex,
      authored: {
        from,
        to,
        label: dep.label ?? null,
        dashed: Boolean(dep.dashed),
      },
      originalSourceState: originalSourceState(from, fromKind),
      displayed: kind === "rendered"
        ? { from: displayedFrom, to: displayedTo, sourceState: displayedSourceState }
        : null,
      kind,
    });
  }

  const displayedModels = mode === "expanded"
    ? allModelIds
    : mode === "collapsed"
      ? topLevelModels
      : detailModelIds;
  const displayedModelSet = new Set(displayedModels);
  const displayedEntities = entities
    .map((entity) => entity.id)
    .filter((entityId) => {
      if (mode === "detail") return detailEntitySet.has(entityId);
      const owner = nearestModelByEntity.get(entityId);
      if (!owner) return true;
      if (mode === "expanded") return true;
      if (mode === "collapsed") return false;
      return !displayedModelSet.has(owner);
    });

  const topLevelRoles = topLevel.map((subgraph) => ({
    id: subgraph.id,
    label: subgraph.title ?? subgraph.id,
    role: models.has(subgraph.id) ? "model" : "lane",
  }));

  const signalOwners = uniqueStable(
    entities.flatMap((entity) =>
      (entity.signals ?? []).map((signal) => `${signal.signalId}:::${entity.id}`)
    )
  ).map((key) => {
    const [signalId, ownerEntityId] = key.split(":::");
    return { signalId, ownerEntityId };
  });

  const traceModels = allModelIds.map((id) => {
    let topLevelGroupId = id;
    for (let parent = parentById.get(id) ?? null; parent; parent = parentById.get(parent) ?? null) topLevelGroupId = parent;
    return {
      id,
      name: subgraphById.get(id)?.title ?? id,
      state: modelStateById.get(id),
      detailRef: models.get(id)?.detailRef ?? null,
      topLevelGroupId,
      parentId: modelParent.get(id) ?? null,
      nearestModelParentId: modelParent.get(id) ?? null,
      directEntityIds: [...(directEntityIdsByModel.get(id) ?? [])],
    };
  });

  const traceEntities = entities.map((entity) => {
    let topLevelGroupId = null;
    for (const top of topLevel) {
      const members = entitiesBySubgraph.get(top.id) ?? [];
      if (members.includes(entity.id)) {
        topLevelGroupId = top.id;
        break;
      }
    }
    return {
      id: entity.id,
      state: entity.state,
      nearestModelId: nearestModelByEntity.get(entity.id) ?? null,
      topLevelGroupId,
    };
  });

  return {
    models: traceModels,
    projection: {
      mode,
      detailFocus,
      displayed: {
        models: displayedModels,
        entities: displayedEntities,
      },
      relationships: renderedRelationships,
      topLevelRoles,
    },
    trace: {
      models: traceModels,
      entities: traceEntities,
      signalOwners,
      relationships: traceRelationships,
    },
  };
}
