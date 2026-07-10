# diagrammo showcase

Run `npx ahm-diagrammo examples/showcase.md -o out-showcase` and open `out-showcase/gallery.html`.
Every block below is plain mermaid — GitHub and VS Code still preview it — but each one carries
diagrammo options a different way.

## Health model, zero config

A `flowchart BT` with the health classes is auto-detected and rendered as a portal-style swimlane.

```mermaid
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

## Fence-info options: theme in the fence line

Same model, midnight theme — the fence reads ` ```mermaid midnight `. GitHub only looks at the
first word of the info string, so its preview is untouched.

```mermaid midnight
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

## YAML frontmatter: title, lanes, real measurements

Mermaid itself understands the frontmatter block, so previews keep working; diagrammo reads the
`diagrammo:` key. Signal rows can carry their own result and state: `name = value (state)`.

```mermaid
---
title: Order pipeline health
diagrammo:
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

## Directive comments: `%%|` lines

Directives are mermaid comments, so they never show up anywhere else.

```mermaid
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

## Any other mermaid still works

Everything that isn't a health model goes through mermaid-cli with the same theme, so a whole
document stays visually consistent. Sequence diagrams, state machines, plain flowcharts, ER —
whatever mermaid can draw.

```mermaid
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

## Plain flowchart, forced theme

```mermaid slate
flowchart LR
    md[Markdown file] --> cli[npx ahm-diagrammo]
    cli --> auto{health model?}
    auto -- yes --> swim[Swimlane SVG]
    auto -- no --> mmd[Themed mermaid SVG]
    swim --> gallery[gallery.html]
    mmd --> gallery
```
