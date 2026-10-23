import { test } from "node:test";
import assert from "node:assert/strict";
import { projectLabelCenterToRelaxedPath, relaxOrthogonalPath } from "../src/route-presentation.mjs";

test("relaxOrthogonalPath widens tiny right-angle corners while keeping endpoints", () => {
  const input = "M232,443.33L232,223.83C232,211.43 239.6,203.83 252,203.83L3373,203.83";
  const relaxed = relaxOrthogonalPath(input, { minCornerRadius: 26, maxCornerRadius: 46 });
  assert.equal(relaxed.changed, true);
  assert.match(relaxed.path, /^M232,443\.33L232,[0-9.]+C232,[0-9.]+ [0-9.]+,203\.83 [0-9.]+,203\.83L3373,203\.83$/);
  assert.ok(relaxed.path.includes("L3373,203.83"), "endpoints must remain unchanged");
});

test("relaxOrthogonalPath widens broad cubic tangents when adjacent leg budget allows", () => {
  const input = "M1828,258.5L1828,120.5C1828,105.38 3263.17,75.13 3263.17,60L3263.17,54";
  const relaxed = relaxOrthogonalPath(input, { minCornerRadius: 26, maxCornerRadius: 46 });
  assert.equal(relaxed.changed, true);
  assert.equal(relaxed.reason, "relaxed-cubic-tangents");
  assert.notEqual(relaxed.path, input);
  assert.match(relaxed.path, /^M1828,258\.5L1828,[0-9.]+C1828,[0-9.]+ 3263\.17,[0-9.]+ 3263\.17,[0-9.]+L3263\.17,54$/);
});

test("relaxOrthogonalPath accepts quadratic commands and keeps unsupported commands explicit", () => {
  const withQuadratic = relaxOrthogonalPath("M0,0Q5,5 10,0L20,0", { minCornerRadius: 26, maxCornerRadius: 46 });
  assert.equal(withQuadratic.changed, false);
  assert.equal(withQuadratic.path, "M0,0Q5,5 10,0L20,0");

  assert.throws(
    () => relaxOrthogonalPath("M0,0A5,5 0 0 1 10,10", { minCornerRadius: 26, maxCornerRadius: 46 }),
    /unsupported path command A/
  );
});

test("projectLabelCenterToRelaxedPath preserves closest-point correspondence across M/L/C/Q", () => {
  const nativePath = "M0,0L0,60C0,80 80,80 80,100Q80,120 100,120";
  const relaxedPath = "M0,0L0,30C0,90 80,90 80,120Q80,140 100,140";
  const nativeCenter = { x: 34, y: 82 };
  const projected = projectLabelCenterToRelaxedPath(nativePath, relaxedPath, nativeCenter);
  assert.ok(Number.isFinite(projected.x) && Number.isFinite(projected.y));
  assert.ok(projected.nativeDistance >= 0);
  assert.ok(projected.y > nativeCenter.y, "projection should follow the relaxed downstream shift");
});

test("projectLabelCenterToRelaxedPath keeps unsupported commands explicit", () => {
  assert.throws(
    () => projectLabelCenterToRelaxedPath(
      "M0,0A5,5 0 0 1 10,10",
      "M0,0L10,10",
      { x: 5, y: 5 }
    ),
    /unsupported path command A/
  );
});
