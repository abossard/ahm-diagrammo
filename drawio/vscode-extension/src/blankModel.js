// Blank model content and target-name derivation. No `vscode` import.
"use strict";

// Draw.io recognises .drawio.svg files by the embedded mxfile in the outer content attribute.
var EMPTY_DRAWIO_SVG =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n' +
  '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ' +
  'version="1.1" width="16px" height="16px" viewBox="-0.5 -0.5 16 16" ' +
  'content="&lt;mxfile host=&quot;AHM Diagrammo&quot;&gt;' +
  '&lt;diagram id=&quot;blank&quot; name=&quot;Page-1&quot;&gt;' +
  '&lt;mxGraphModel dx=&quot;1200&quot; dy=&quot;800&quot; grid=&quot;1&quot; gridSize=&quot;10&quot; ' +
  'guides=&quot;1&quot; tooltips=&quot;1&quot; connect=&quot;1&quot; arrows=&quot;1&quot; ' +
  'fold=&quot;1&quot; page=&quot;1&quot; pageScale=&quot;1&quot; pageWidth=&quot;827&quot; ' +
  'pageHeight=&quot;1169&quot; math=&quot;0&quot; shadow=&quot;0&quot;&gt;' +
  '&lt;root&gt;&lt;mxCell id=&quot;0&quot;/&gt;&lt;mxCell id=&quot;1&quot; parent=&quot;0&quot;/&gt;' +
  '&lt;/root&gt;&lt;/mxGraphModel&gt;&lt;/diagram&gt;&lt;/mxfile&gt;">' +
  '<defs/><rect fill="#ffffff" width="100%" height="100%" x="0" y="0"/><g/></svg>';

function defaultFileName() {
  var now = new Date();
  var pad = function (n) { return String(n).padStart(2, "0"); };
  return "ahm-model-" + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + ".drawio.svg";
}

module.exports = { EMPTY_DRAWIO_SVG, defaultFileName };
