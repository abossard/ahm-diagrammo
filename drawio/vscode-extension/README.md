# AHM Diagrammo

A VS Code extension for authoring AHM (Application Health Model) diagrams using [Draw.io Integration](https://marketplace.visualstudio.com/items?itemName=hediet.vscode-drawio).

## Install

1. Install [Draw.io Integration](https://marketplace.visualstudio.com/items?itemName=hediet.vscode-drawio) (`hediet.vscode-drawio`) from the VS Code Marketplace.
2. Install this extension from the `.vsix` file: open the Command Palette, run **Extensions: Install from VSIX...**, and select `ahm-diagrammo-<version>.vsix`.

## Enable

Run the command **AHM Diagrammo: Enable in Draw.io** from the Command Palette. Choose Global (User Settings) or Workspace scope.

When Draw.io opens, you will be prompted to trust the AHM plugin. Use **AHM Diagrammo: Show Plugin Fingerprint** to verify the sha256 hash before approving.

> **Trust prompt.** The Draw.io Integration extension requires explicit approval for each plugin. This is a security feature and cannot be bypassed. You must click "Allow" when prompted. The fingerprint shown in the trust dialog should match the one from the Show Plugin Fingerprint command.

## Create a New Model

Run **AHM Diagrammo: Create New AHM Health Model** to create a blank `.drawio.svg` canvas.

## Authoring Walkthrough

### Add an Entity

Drag an entity template from the **AHM Diagrammo** library palette onto the canvas. Each dropped entity receives a unique semantic ID automatically.

### Add a Signal

Select an entity, then use **AHM Health Model > Add Signal** from the Draw.io menu, or drag a signal from the library palette.

### Connect a Dependency

Draw a native edge between two entities. The connector is automatically tagged as an AHM dependency with standard impact. Alternatively, select two or more entities and use **AHM Health Model > Connect as Dependency**.

### Create a Swimlane

Drag a swimlane template from the **AHM Diagrammo** library palette onto the canvas and arrange entities within it.

### Add a Legend

Drag the legend template from the **AHM Diagrammo** library palette onto the canvas.

### Set Health and Impact

Right-click an entity or use the **AHM Health Model** menu to set health state (Healthy, Degraded, Unhealthy, Unknown) or impact level (Standard, Limited, Suppressed).

### Validate and Recalculate

Use **AHM Health Model > Validate** to check your model for errors. Use **AHM Health Model > Recalculate** to recompute all derived states.

## Disable

Run **AHM Diagrammo: Disable in Draw.io** to remove the plugin and library configuration.

## Examples

The repository includes example diagrams in `drawio/examples/` for demonstration only. These are not shipped with the extension.

## Notes

- This extension depends on `hediet.vscode-drawio` (Draw.io Integration) and will not activate without it.
- Plugin paths in settings are absolute and machine-specific. They are set at runtime and never stored in diagram files.
