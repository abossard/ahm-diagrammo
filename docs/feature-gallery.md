# Feature gallery (source of truth)

This page is the source for its own images.

Regenerate both rendering sets from these Mermaid blocks:

```bash
npx ahm-diagrammo docs/feature-gallery.md -o docs/assets/feature-gallery/ahm --no-gallery
npx ahm-diagrammo docs/feature-gallery.md -o docs/assets/feature-gallery/vanilla -r mermaid --no-gallery
```

For each feature: Mermaid source first, then `vanilla` (`-r mermaid`) and `ahm-diagrammo` (`auto`) output.

## 1. Auto health-model detection (`flowchart BT` + health classes)

```mermaid
%%| name: auto-health-model-detection
flowchart BT
    webSig["Availability<br/>P95 latency"] --> web["Web frontend<br/>healthy"]
    apiSig["Error rate<br/>Request rate"] --> api["API service<br/>degraded"]
    dbSig["DTU utilization<br/>Replication lag"] --> db["Database<br/>healthy"]

    web --> checkout["Checkout flow<br/>degraded"]
    api --> checkout
    db --> checkout
    checkout --> root["Workload root<br/>(worstOf)<br/>degraded"]

    classDef blue fill:#eff6fc,stroke:#0078D4;
    classDef green fill:#f2f8f2,stroke:#a0d8a0;
    classDef amber fill:#fbf2e7,stroke:#db7500;
    class webSig,apiSig,dbSig blue;
    class web,db green;
    class api,checkout,root amber;
```

| Vanilla Mermaid | ahm-diagrammo |
|---|---|
| ![Auto health model, vanilla](assets/feature-gallery/vanilla/auto-health-model-detection.svg) | ![Auto health model, ahm](assets/feature-gallery/ahm/auto-health-model-detection.svg) |

## 2. Fence-info options (`mermaid midnight`)

```mermaid midnight
%%| name: fence-info-theme
flowchart BT
    webSig["Availability<br/>P95 latency"] --> web["Web frontend<br/>healthy"]
    apiSig["Error rate<br/>Request rate"] --> api["API service<br/>unhealthy"]
    web --> checkout["Checkout flow<br/>unhealthy"]
    api --> checkout
    checkout --> root["Workload root<br/>unhealthy"]

    classDef blue fill:#eff6fc,stroke:#0078D4;
    classDef green fill:#f2f8f2,stroke:#a0d8a0;
    classDef red fill:#faeceb,stroke:#ba0d16;
    class webSig,apiSig blue;
    class web green;
    class api,checkout,root red;
```

| Vanilla Mermaid | ahm-diagrammo |
|---|---|
| ![Fence info, vanilla](assets/feature-gallery/vanilla/fence-info-theme.svg) | ![Fence info, ahm](assets/feature-gallery/ahm/fence-info-theme.svg) |

## 3. YAML frontmatter (`title`, `theme`, `subtitle`, `lanes`)

```mermaid
---
title: Order pipeline health
diagrammo:
  name: yaml-frontmatter-options
  theme: candy
  subtitle: Live measurements flow in from the collectors on the left.
  lanes: [Storefront, Order flows, Services]
---
flowchart BT
    apiSig["P95 latency = 230 ms (degraded)<br/>Error rate = 0.4%<br/>Requests = 1.2k/s"] --> api["Order API<br/>degraded"]
    qSig["Queue depth = 18<br/>Oldest message = 4 s"] --> queue["Order queue<br/>healthy"]
    paySig["Auth failures = 7% (unhealthy)<br/>Settlement lag = 12 min (degraded)"] --> pay["Payment service<br/>unhealthy"]

    api --> orders["Order intake<br/>degraded"]
    queue --> orders
    pay -. "limited<br/>propagation" .-> orders
    orders --> root["Storefront<br/>(worstOf)<br/>degraded"]

    classDef blue fill:#eff6fc,stroke:#0078D4;
    classDef green fill:#f2f8f2,stroke:#a0d8a0;
    classDef amber fill:#fbf2e7,stroke:#db7500;
    classDef red fill:#faeceb,stroke:#ba0d16;
    class apiSig,qSig,paySig blue;
    class queue green;
    class api,orders,root amber;
    class pay red;
```

| Vanilla Mermaid | ahm-diagrammo |
|---|---|
| ![Frontmatter options, vanilla](assets/feature-gallery/vanilla/yaml-frontmatter-options.svg) | ![Frontmatter options, ahm](assets/feature-gallery/ahm/yaml-frontmatter-options.svg) |

## 4. Directive comments (`%%|`) and `legend: false`

```mermaid
%%| name: directive-comments-options
%%| theme: slate
%%| title: Ingestion path
%%| subtitle: Slate theme, legend switched off.
%%| legend: false
flowchart BT
    inSig["Events/s<br/>Drop rate"] --> ingest["Ingest gateway<br/>healthy"]
    procSig["Lag<br/>Failures"] --> proc["Stream processor<br/>degraded"]
    ingest --> pipeline["Telemetry pipeline<br/>degraded"]
    proc --> pipeline
    pipeline --> root["Observability root<br/>degraded"]

    classDef blue fill:#eff6fc,stroke:#0078D4;
    classDef green fill:#f2f8f2,stroke:#a0d8a0;
    classDef amber fill:#fbf2e7,stroke:#db7500;
    class inSig,procSig blue;
    class ingest green;
    class proc,pipeline,root amber;
```

| Vanilla Mermaid | ahm-diagrammo |
|---|---|
| ![Directive options, vanilla](assets/feature-gallery/vanilla/directive-comments-options.svg) | ![Directive options, ahm](assets/feature-gallery/ahm/directive-comments-options.svg) |

## 5. Signal-row values and row states

```mermaid
%%| name: signal-values-and-states
flowchart BT
    sig["Availability = 99.98% (healthy)<br/>Error rate = 3.1% (unhealthy)<br/>Latency p95 = 240 ms (degraded)"] --> api["Checkout API<br/>degraded"]
    api --> root["Storefront<br/>degraded"]

    classDef blue fill:#eff6fc,stroke:#0078D4;
    classDef amber fill:#fbf2e7,stroke:#db7500;
    class sig blue;
    class api,root amber;
```

| Vanilla Mermaid | ahm-diagrammo |
|---|---|
| ![Signal values and states, vanilla](assets/feature-gallery/vanilla/signal-values-and-states.svg) | ![Signal values and states, ahm](assets/feature-gallery/ahm/signal-values-and-states.svg) |

## 6. Dashed propagation edges and relationship pills

```mermaid
%%| name: dashed-propagation-edge
flowchart BT
    svcSig["Latency<br/>Retries"] --> svc["Service A<br/>healthy"]
    depSig["Error burst<br/>Circuit open"] --> dep["Service B<br/>unhealthy"]

    svc --> flow["Checkout flow<br/>degraded"]
    dep -. "limited<br/>propagation" .-> flow
    flow --> root["Workload root<br/>degraded"]

    classDef blue fill:#eff6fc,stroke:#0078D4;
    classDef green fill:#f2f8f2,stroke:#a0d8a0;
    classDef amber fill:#fbf2e7,stroke:#db7500;
    classDef red fill:#faeceb,stroke:#ba0d16;
    class svcSig,depSig blue;
    class svc green;
    class dep red;
    class flow,root amber;
```

| Vanilla Mermaid | ahm-diagrammo |
|---|---|
| ![Dashed propagation, vanilla](assets/feature-gallery/vanilla/dashed-propagation-edge.svg) | ![Dashed propagation, ahm](assets/feature-gallery/ahm/dashed-propagation-edge.svg) |

## 7. Non-health Mermaid blocks (sequence)

```mermaid
%%| name: non-health-sequence
sequenceDiagram
    participant U as User
    participant W as Web frontend
    participant A as Order API
    participant Q as Order queue
    U->>W: Place order
    W->>A: POST /orders
    A->>Q: enqueue
    A-->>W: 202 Accepted
    W-->>U: Confirmation
```

| Vanilla Mermaid | ahm-diagrammo |
|---|---|
| ![Sequence, vanilla](assets/feature-gallery/vanilla/non-health-sequence.svg) | ![Sequence, ahm](assets/feature-gallery/ahm/non-health-sequence.svg) |

## 8. Forcing a renderer (`renderer: mermaid` on a health model)

```mermaid
%%| name: forced-renderer-mermaid
%%| renderer: mermaid
flowchart BT
    sig["Error rate<br/>P95 latency"] --> api["Order API<br/>degraded"]
    api --> root["Storefront<br/>degraded"]

    classDef blue fill:#eff6fc,stroke:#0078D4;
    classDef amber fill:#fbf2e7,stroke:#db7500;
    class sig blue;
    class api,root amber;
```

| Vanilla Mermaid | ahm-diagrammo |
|---|---|
| ![Forced mermaid, vanilla](assets/feature-gallery/vanilla/forced-renderer-mermaid.svg) | ![Forced mermaid, ahm](assets/feature-gallery/ahm/forced-renderer-mermaid.svg) |

## 9. `name` and `background` options on plain Mermaid

```mermaid
%%| name: custom-name-and-background
%%| background: transparent
flowchart LR
    md[Markdown file] --> cli[npx ahm-diagrammo]
    cli --> auto{health model?}
    auto -- yes --> swim[Swimlane SVG]
    auto -- no --> mmd[Themed mermaid SVG]
```

| Vanilla Mermaid | ahm-diagrammo |
|---|---|
| ![Custom name and background, vanilla](assets/feature-gallery/vanilla/custom-name-and-background.svg) | ![Custom name and background, ahm](assets/feature-gallery/ahm/custom-name-and-background.svg) |

## 10. Theme override on plain flowchart

```mermaid slate
%%| name: plain-flowchart-theme
flowchart LR
    source[Mermaid source] --> vanilla[vanilla renderer]
    source --> swimlane[swimlane renderer]
    vanilla --> compare[compare outputs]
    swimlane --> compare
```

| Vanilla Mermaid | ahm-diagrammo |
|---|---|
| ![Plain flowchart theme, vanilla](assets/feature-gallery/vanilla/plain-flowchart-theme.svg) | ![Plain flowchart theme, ahm](assets/feature-gallery/ahm/plain-flowchart-theme.svg) |
