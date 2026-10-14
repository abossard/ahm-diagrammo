// Pure settings merge/remove functions. No `vscode` import.
"use strict";

/**
 * Returns a new array with our entry appended, stale versions removed.
 * Stale entries are detected by checking if entry.file ends with the same
 * asset-relative path as ours (works in both installed and dev modes).
 * @param {Array} current - existing setting array
 * @param {object} ours - entry to add (must have .file)
 * @param {string} extensionIdPrefix - e.g. "abossard.ahm-diagrammo"
 * @returns {Array}
 */
function mergeEntry(current, ours, extensionIdPrefix) {
  if (current === undefined) current = [];
  if (!Array.isArray(current)) {
    throw new TypeError("AHM Diagrammo: expected Draw.io setting to be an array");
  }
  // Remove entries that are either: (a) from any installed version of this extension
  // (path contains publisher.name), or (b) point to the exact same file as ours.
  var filtered = current.filter(function (entry) {
    if (!entry || typeof entry.file !== "string") return true;
    if (entry.file.indexOf(extensionIdPrefix) >= 0) return false;
    if (entry.file === ours.file) return false;
    return true;
  });
  filtered.push(ours);
  return filtered;
}

/**
 * Returns a new array with all entries whose file contains extensionIdPrefix
 * or matches oursFile removed.
 * @param {Array} current
 * @param {string} extensionIdPrefix
 * @param {string} [extensionPath] - if provided, also removes entries whose file starts with this path
 * @returns {Array}
 */
function removeEntries(current, extensionIdPrefix, extensionPath) {
  if (!Array.isArray(current)) return [];
  return current.filter(function (entry) {
    if (!entry || typeof entry.file !== "string") return true;
    if (entry.file.indexOf(extensionIdPrefix) >= 0) return false;
    if (extensionPath && entry.file.indexOf(extensionPath) >= 0) return false;
    return true;
  });
}

module.exports = { mergeEntry, removeEntries };
