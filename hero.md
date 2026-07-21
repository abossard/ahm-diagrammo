**README's hero figure** — the lead image under `## Examples`. Recreated as editable Mermaid
after the original hero screenshot (a now-removed PNG, replaced by this file + `svg/hero.svg`)
was found to depict a materially different 10-entity "Workload root" shop model, not the 5-node
`why-not-just-vanilla-mermaid` diagram it had been deduplicated with. No Mermaid source for it was
ever committed; the exact node/edge/label/state graph below is reconstructed from the deleted
hand-authored `swimlane.mjs` (git history, commit `914d07a`, comment `model (hero: shop
workload)`) and cross-checked against the original screenshot pixel-for-pixel, including its
auto-generated per-metric numbers. Left without a heading on purpose, so the rendered
title/subtitle stay the renderer's own defaults — exactly what the original screenshot shows.

Regenerate: `node bin/diagrammo.mjs hero.md -o <dir> --no-gallery`, then copy the emitted SVG over
`svg/hero.svg`.

```mermaid
flowchart BT
    %% ---- signals (blue), one row set per component ----
    webSig["Web latency<br/>HTTP 5xx rate<br/>Request rate"] --> web["Web frontend<br/>healthy"]
    appSig["CPU<br/>Memory<br/>Restart count"] --> app["App hosting<br/>healthy"]
    dbSig["Connection<br/>DTU utilization<br/>Failed connections"] --> db["Database<br/>healthy"]
    anaSig["Pipeline lag<br/>Ingestion errors<br/>Data freshness"] --> analytics["Analytics store<br/>healthy"]
    queueSig["Queue depth<br/>Oldest message age<br/>Dead-letter count"] --> queue["Order queue<br/>degraded"]
    shipSig["Carrier API availability<br/>Carrier API latency<br/>Error rate"] --> ship["Shipping service<br/>healthy"]

    %% ---- components -> business flows ----
    web --> shop["Shop and commerce<br/>healthy"]
    app --> shop
    db --> shop

    db --> reporting["Reporting<br/>healthy"]
    analytics --> reporting

    queue --> logistics["Logistics<br/>degraded"]
    ship --> logistics

    %% ---- flows -> root ----
    shop --> root["Workload root<br/>degraded"]
    reporting --> root
    logistics --> root

    classDef blue fill:#eff6fc,stroke:#0078D4;
    classDef green fill:#f2f8f2,stroke:#a0d8a0;
    classDef amber fill:#fbf2e7,stroke:#db7500;
    class webSig,appSig,dbSig,anaSig,queueSig,shipSig blue;
    class web,app,db,analytics,ship,shop,reporting green;
    class queue,logistics,root amber;
```
