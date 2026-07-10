# Deep model with lane-skipping edges

Six layers; several edges skip multiple lanes (bottom entities feeding the root directly), which
forces corridor routing through intermediate lanes. Multiple skippers share corridors.

```mermaid
flowchart BT
    m1["Metric collector one"] --> l5a["Leaf five A<br/>healthy"]
    m2["Metric collector two"] --> l5b["Leaf five B<br/>degraded"]
    m3["Metric collector three"] --> l5c["Leaf five C<br/>healthy"]

    l5a --> l4a["Mid four A<br/>healthy"]
    l5b --> l4a
    l5c --> l4b["Mid four B<br/>degraded"]

    l4a --> l3a["Mid three A<br/>healthy"]
    l4b --> l3b["Mid three B<br/>degraded"]

    l3a --> l2a["Flow two A<br/>healthy"]
    l3b --> l2b["Flow two B<br/>degraded"]

    l2a --> root["Workload root<br/>degraded"]
    l2b --> root

    %% lane skippers: 3, 4 and 5 lanes up, two of them labeled, one dashed
    l5a -- "skips three lanes" --> l2a
    l5b -. "direct to root" .-> root
    l4b -->|skips two| root
    l5c --> l3a
    l5c -- "another long hop" --> root

    classDef blue fill:#eff6fc,stroke:#0078D4;
    classDef green fill:#f2f8f2,stroke:#a0d8a0;
    classDef amber fill:#fbf2e7,stroke:#db7500;
    class m1,m2,m3 blue;
    class l5a,l5c,l4a,l3a,l2a green;
    class l5b,l4b,l3b,l2b,root amber;
```
