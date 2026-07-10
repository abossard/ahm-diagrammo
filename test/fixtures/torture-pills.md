# Pill flood

Twelve labeled edges converge on one parent while a second parent shares several of the same
children; long labels, dashed labeled edges, and near-identical child positions all at once.

```mermaid
flowchart BT
    c1["Alpha service<br/>healthy"] -->|reads| hub["Aggregation hub<br/>degraded"]
    c2["Beta service<br/>healthy"] -->|writes| hub
    c3["Gamma service<br/>degraded"] -- "asynchronous replication path" --> hub
    c4["Delta service<br/>healthy"] -->|caches| hub
    c5["Epsilon service<br/>healthy"] -. "limited propagation window" .-> hub
    c6["Zeta service<br/>unhealthy"] -->|streams| hub
    c7["Eta service<br/>healthy"] -- "bulk import" --> hub
    c8["Theta service<br/>healthy"] -->|queries| hub
    c9["Iota service<br/>degraded"] -. "sampled telemetry" .-> hub
    c10["Kappa service<br/>healthy"] -->|events| hub
    c11["Lambda service<br/>healthy"] -- "change data capture" --> hub
    c12["Mu service<br/>healthy"] -->|syncs| hub

    c1 -->|also feeds| mirror["Mirror hub<br/>healthy"]
    c3 -- "secondary rollup with an extremely long relationship label" --> mirror
    c6 -->|failover| mirror
    c12 -. "sampled" .-> mirror

    hub --> root["Workload root<br/>degraded"]
    mirror --> root

    classDef green fill:#f2f8f2,stroke:#a0d8a0;
    classDef amber fill:#fbf2e7,stroke:#db7500;
    classDef red fill:#faeceb,stroke:#ba0d16;
    class c1,c2,c4,c5,c7,c8,c10,c11,c12,mirror green;
    class c3,c9,hub,root amber;
    class c6 red;
```
